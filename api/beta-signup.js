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

    /* ── 2. Send email to user via Resend ──
     * Gmail auto-collapses "repeated content" it has seen from the same
     * sender before. Two things we do to defeat that:
     *   1. Every visible section carries the license key or a per-signup
     *      unique reference, so no two emails look identical.
     *   2. Critical activation instructions appear ABOVE the download
     *      links, so even if Gmail decided to hide something the user
     *      still sees what they need to actually activate.
     */
    const signupRef  = `${Date.now().toString(36).toUpperCase()}-${licenseKey.slice(0, 6)}`;
    const signupDate = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

    const userEmailBody = {
      from: 'CyberRMF <no-reply@integratermf.com>',
      to: [email],
      subject: `Your CyberRMF Beta License — ${licenseKey}`,
      html: `
        <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:640px;margin:0 auto;">
          <h2 style="color:#60a5fa;margin:0 0 4px;">Welcome to the CyberRMF Beta, ${firstName}!</h2>
          <p style="color:#6b7280;font-size:11px;margin:0 0 20px;">Signup ref ${signupRef} &middot; ${signupDate}</p>

          <!-- ══════════ DOWNLOADS (top of email per user feedback) ══════════ -->
          <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:20px;">
            <p style="font-size:11px;color:#9ca3af;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em;">Downloads (Windows x64)</p>
            <p style="margin:0 0 8px;">
              <a href="${DOWNLOAD_INTEGRATE}" style="color:#60a5fa;font-size:13px;text-decoration:none;">&#10515; CyberRMF Integrate Setup (.exe)</a>
            </p>
            <p style="margin:0;">
              <a href="${DOWNLOAD_ADMIN}" style="color:#60a5fa;font-size:13px;text-decoration:none;">&#10515; CyberRMF Admin Tools Setup (.exe)</a>
            </p>
          </div>

          <!-- ══════════ LICENSE KEY (unique per-signup) ══════════ -->
          <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:20px;">
            <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Your License Key</p>
            <p style="font-size:16px;font-weight:700;color:#60a5fa;margin:0;word-break:break-all;">${licenseKey}</p>
            <p style="font-size:11px;color:#6b7280;margin:8px 0 0;">Valid for 14 days &middot; works for both apps &middot; up to 2 machines.</p>
          </div>

          <!-- ══════════ WHAT TO DO NEXT (activation FIRST, before downloads) ══════════ -->
          <p style="font-size:14px;color:#e4e6eb;margin:24px 0 12px;font-weight:600;">How to activate on ${firstName ? firstName + "'s" : 'your'} machine (ref ${signupRef.slice(0, 8)}):</p>

          <!-- Option A — Online -->
          <div style="background:#1e2a3a;border:1px solid #2563eb;border-radius:6px;padding:16px;margin-bottom:14px;">
            <p style="font-size:11px;color:#60a5fa;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Option A &mdash; Online Activation</p>
            <p style="font-size:12px;color:#9ca3af;margin:0 0 10px;line-height:1.5;">
              Use this if the machine has internet access.
            </p>
            <ol style="font-size:13px;color:#e4e6eb;margin:0;padding-left:20px;line-height:1.75;">
              <li>Launch the app and click <strong>Online Activation</strong></li>
              <li>Paste your key: <span style="color:#60a5fa;font-family:monospace;">${licenseKey}</span></li>
              <li>Click <strong>Activate License</strong> &mdash; done</li>
            </ol>
          </div>

          <!-- Option B — Offline / Air-Gapped -->
          <div style="background:#241d33;border:1px solid #8b5cf6;border-radius:6px;padding:16px;margin-bottom:20px;">
            <p style="font-size:11px;color:#a78bfa;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Option B &mdash; Offline / Air-Gapped Activation</p>
            <p style="font-size:12px;color:#9ca3af;margin:0 0 10px;line-height:1.5;">
              Use this if the machine has <strong>no internet access</strong>. You do part of this from your phone or another online device &mdash; no USB drives or file transfers needed.
            </p>
            <ol style="font-size:13px;color:#e4e6eb;margin:0 0 14px;padding-left:20px;line-height:1.75;">
              <li>Launch the app on the offline machine and click <strong>Air-Gapped Activation</strong></li>
              <li>The app shows an <strong>activation code</strong> derived from that machine &mdash; write it down or copy it</li>
              <li>On any online device (or phone), open the offline activation portal (button below)</li>
              <li>Enter your license key <span style="color:#a78bfa;font-family:monospace;">${licenseKey}</span>, your email, and the activation code &mdash; you'll receive a <strong>response code</strong></li>
              <li>Type the response code back into the offline app to complete activation</li>
            </ol>
            <div style="text-align:center;margin:14px 0 4px;">
              <a href="https://integratermf.com/activate"
                 style="display:inline-block;background:#8b5cf6;color:#fff;text-decoration:none;padding:12px 26px;border-radius:6px;font-size:13px;font-weight:600;letter-spacing:0.02em;">
                Open Offline Activation Portal &rarr;
              </a>
            </div>
            <p style="font-size:11px;color:#6b7280;margin:10px 0 0;text-align:center;line-height:1.5;">
              Or paste this URL into any online device:<br/>
              <span style="color:#a78bfa;font-family:monospace;font-size:12px;">https://integratermf.com/activate</span>
            </p>
          </div>

          <p style="font-size:12px;color:#6b7280;margin:24px 0 0;text-align:center;">
            Questions? Reply to this email or contact <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
            <br/><span style="font-size:10px;color:#4b5563;">Signup ref ${signupRef}</span>
          </p>
        </div>
      `,
      text: [
        `Welcome to the CyberRMF Beta, ${firstName}!`,
        `Signup ref: ${signupRef}   |   ${signupDate}`,
        ``,
        `DOWNLOADS (Windows x64)`,
        `  Integrate:   ${DOWNLOAD_INTEGRATE}`,
        `  Admin Tools: ${DOWNLOAD_ADMIN}`,
        ``,
        `YOUR LICENSE KEY`,
        `  ${licenseKey}`,
        `  (valid for 14 days, works for both apps, up to 2 machines)`,
        ``,
        `HOW TO ACTIVATE`,
        ``,
        `Option A - Online Activation (for machines with internet):`,
        `  1. Launch the app and click "Online Activation"`,
        `  2. Paste your license key: ${licenseKey}`,
        `  3. Click "Activate License"`,
        ``,
        `Option B - Offline / Air-Gapped Activation (for isolated machines):`,
        `  1. Launch the app on the offline machine, click "Air-Gapped Activation"`,
        `  2. Write down the activation code the app displays`,
        `  3. On any online device, open: https://integratermf.com/activate`,
        `  4. Enter your license key, email, and activation code -> get a response code`,
        `  5. Type the response code back into the offline app`,
        ``,
        `Questions? Reply to this email or contact info@cyberrmf.com`,
        `-- Signup ref ${signupRef} --`,
      ].join('\n'),
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
        from: 'CyberRMF <no-reply@integratermf.com>',
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
