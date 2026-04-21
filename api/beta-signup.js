const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const KEYGEN_POLICY_ID   = process.env.KEYGEN_POLICY_ID;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;
const DOWNLOAD_INTEGRATE = process.env.GITHUB_DOWNLOAD_INTEGRATE;
const DOWNLOAD_ADMIN     = process.env.GITHUB_DOWNLOAD_ADMIN;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const missing = [];
  if (!KEYGEN_ACCOUNT_ID)  missing.push('KEYGEN_ACCOUNT_ID');
  if (!KEYGEN_ADMIN_TOKEN) missing.push('KEYGEN_ADMIN_TOKEN');
  if (!KEYGEN_POLICY_ID)   missing.push('KEYGEN_POLICY_ID');
  if (!RESEND_API_KEY)     missing.push('RESEND_API_KEY');
  if (missing.length) {
    console.error('Missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error', debug: `Missing: ${missing.join(', ')}` });
  }

  const { firstName, lastName, email, pulseCapability, tools, benefit, comments } = req.body || {};

  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'First name, last name, and email are required' });
  }

  const fullName = `${firstName} ${lastName}`;
  const steps = [];

  try {
    /* ── 1. Create license in Keygen ── */
    const licenseRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEYGEN_ADMIN_TOKEN}`,
          'Content-Type': 'application/vnd.api+json',
          Accept: 'application/vnd.api+json',
        },
        body: JSON.stringify({
          data: {
            type: 'licenses',
            attributes: {
              name: `Beta - ${fullName}`,
              metadata: {
                email,
                organization: '',
                role: '',
                pulseCapability: pulseCapability || '',
                tools: tools || '',
                benefit: benefit || '',
                comments: comments || '',
              },
            },
            relationships: {
              policy: {
                data: { type: 'policies', id: KEYGEN_POLICY_ID },
              },
            },
          },
        }),
      }
    );

    const licenseBody = await licenseRes.json();

    if (!licenseRes.ok) {
      console.error('Keygen error:', JSON.stringify(licenseBody));
      return res.status(502).json({ error: 'Failed to create license', debug: licenseBody });
    }

    const licenseKey = licenseBody.data.attributes.key;
    steps.push('license_created');

    /* ── 2. Send email to user via Resend ── */
    const userEmailBody = {
      from: 'CyberRMF <onboarding@resend.dev>',
      to: [email],
      subject: 'Your CyberRMF Beta Access — License Key & Downloads',
      html: `
        <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
          <h2 style="color:#60a5fa;margin:0 0 8px;">Welcome to the CyberRMF Beta, ${firstName}!</h2>
          <p style="color:#9ca3af;font-size:13px;margin:0 0 24px;">Thank you for requesting access. Below is everything you need to get started.</p>

          <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:20px;">
            <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Your License Key</p>
            <p style="font-size:16px;font-weight:700;color:#60a5fa;margin:0;word-break:break-all;">${licenseKey}</p>
            <p style="font-size:11px;color:#6b7280;margin:8px 0 0;">This key is valid for 14 days and works for both applications.</p>
          </div>

          <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:20px;">
            <p style="font-size:11px;color:#9ca3af;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em;">Download Links</p>
            <p style="margin:0 0 8px;">
              <a href="${DOWNLOAD_INTEGRATE}" style="color:#60a5fa;font-size:13px;text-decoration:none;">&#10515; CyberRMF Integrate Setup (.exe)</a>
            </p>
            <p style="margin:0;">
              <a href="${DOWNLOAD_ADMIN}" style="color:#60a5fa;font-size:13px;text-decoration:none;">&#10515; CyberRMF Admin Tools Setup (.exe)</a>
            </p>
          </div>

          <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:20px;">
            <p style="font-size:11px;color:#9ca3af;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.05em;">Getting Started</p>
            <ol style="font-size:13px;color:#e4e6eb;margin:0;padding-left:18px;line-height:1.8;">
              <li>Download and install both applications above</li>
              <li>When prompted, paste your license key</li>
              <li>One license key activates both apps (up to 2 machines)</li>
            </ol>
          </div>

          <p style="font-size:12px;color:#6b7280;margin:24px 0 0;text-align:center;">
            Questions? Reply to this email or contact <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
          </p>
        </div>
      `,
    };

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(userEmailBody),
    });

    const emailResBody = await emailRes.text();
    let emailResJson;
    try { emailResJson = JSON.parse(emailResBody); } catch (_) { emailResJson = emailResBody; }

    if (!emailRes.ok) {
      console.error('Resend user-email error:', emailRes.status, emailResBody);
      steps.push('user_email_failed');
      return res.status(200).json({
        success: false,
        error: 'License created but email failed',
        steps,
        resendStatus: emailRes.status,
        resendError: emailResJson,
        keyPrefix: RESEND_API_KEY ? RESEND_API_KEY.substring(0, 6) + '...' : 'NOT_SET',
      });
    }

    steps.push('user_email_sent');

    /* ── 3. Notify info@cyberrmf.com ── */
    try {
      const adminRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
        from: 'CyberRMF <onboarding@resend.dev>',
        to: ['info@cyberrmf.com'],
          subject: `New Beta Signup: ${fullName}`,
          html: `
            <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:24px;border-radius:8px;max-width:600px;">
              <h2 style="color:#60a5fa;margin:0 0 16px;">New Beta Request</h2>
              <table style="font-size:13px;border-collapse:collapse;width:100%;">
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Name</td><td style="padding:6px 0;">${fullName}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Email</td><td style="padding:6px 0;"><a href="mailto:${email}" style="color:#60a5fa;">${email}</a></td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Pulse Capability</td><td style="padding:6px 0;">${pulseCapability || 'N/A'}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Tools</td><td style="padding:6px 0;">${tools || 'N/A'}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Benefit</td><td style="padding:6px 0;">${benefit || 'N/A'}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Comments</td><td style="padding:6px 0;">${comments || 'N/A'}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">License Key</td><td style="padding:6px 0;color:#22c55e;font-weight:700;word-break:break-all;">${licenseKey}</td></tr>
              </table>
            </div>
          `,
        }),
      });

      if (adminRes.ok) {
        steps.push('admin_email_sent');
      } else {
        const adminErr = await adminRes.text();
        console.error('Admin email error:', adminRes.status, adminErr);
        steps.push('admin_email_failed');
      }
    } catch (adminErr) {
      console.error('Admin notify error:', adminErr);
      steps.push('admin_email_error');
    }

    return res.status(200).json({ success: true, steps });

  } catch (err) {
    console.error('Beta signup error:', err);
    return res.status(500).json({ error: 'Internal server error', debug: err.message, steps });
  }
}
