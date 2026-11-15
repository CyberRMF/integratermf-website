import crypto from 'crypto';
import { missingPolicyEnv, policyIdFor, productName } from './_products.js';

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;
const DOWNLOAD_INTEGRATE = process.env.GITHUB_DOWNLOAD_INTEGRATE;
const DOWNLOAD_ADMIN     = process.env.GITHUB_DOWNLOAD_ADMIN;

// Closed until the paid checkout replaces this free signup (LIC-9). The
// endpoint is public, so hiding the form doesn't stop direct calls.
const SIGNUPS_OPEN = false;

// CAN-SPAM / CASL / Gmail-bulk-sender compliance footer.
// BUSINESS_ADDRESS should be a real, deliverable physical postal address
// (street, suite / PO Box, city, state, ZIP). Set it as a Vercel env var.
const BUSINESS_ADDRESS   = process.env.BUSINESS_ADDRESS ||
  'CyberRMF LLC &middot; [MAILING ADDRESS NOT SET - set BUSINESS_ADDRESS env var in Vercel]';

// Resend Audiences + HMAC-signed unsubscribe. Both envs must be set for
// Tier 1 unsubscribe to be fully automated; if either is missing we fall
// back to mailto-only unsubscribe (still works, just manual processing).
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET;

function buildUnsubUrl(email) {
  if (!UNSUBSCRIBE_SECRET) return null;
  const token = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET)
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 24);
  return `https://integratermf.com/api/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`;
}

/*
 * One license under `product`'s policy. metadata.email is what the License
 * Management endpoints check and where they send codes and notices;
 * metadata.product says which app the license is for.
 */
async function createLicense(product, fullName, metadata) {
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
            name: `${productName(product)} - ${fullName}`,
            metadata: { ...metadata, product },
          },
          relationships: {
            policy: {
              data: { type: 'policies', id: policyIdFor(product) },
            },
          },
        },
      }),
    }
  );
  const body = await licenseRes.json().catch(() => ({}));
  return { ok: licenseRes.ok && !!body?.data?.attributes?.key, body };
}

async function deleteLicense(licenseId) {
  try {
    const delRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses/${licenseId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${KEYGEN_ADMIN_TOKEN}`,
          Accept: 'application/vnd.api+json',
        },
      }
    );
    return delRes.status === 204 || delRes.ok;
  } catch (err) {
    console.error('Keygen license delete error:', err);
    return false;
  }
}

/* Plain-text note to info@cyberrmf.com. A failed send is logged, never thrown. */
async function notifyInfo(subject, text) {
  try {
    const notifyRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'CyberRMF <no-reply@integratermf.com>',
        to: ['info@cyberrmf.com'],
        subject,
        text,
      }),
    });
    if (!notifyRes.ok) {
      console.error('beta-signup: info@ notice failed:', subject, notifyRes.status, await notifyRes.text().catch(() => ''));
    }
  } catch (notifyErr) {
    console.error('beta-signup: info@ notice failed:', subject, notifyErr);
  }
}

/* The buyer has no keys. info@ gets the license IDs and key endings, never the keys. */
function notifyWelcomeEmailFailed(fullName, email, keys) {
  return notifyInfo(`Welcome email failed: ${fullName}`, [
    `The welcome email to ${fullName} (${email}) could not be sent. Both licenses were created, but the buyer has no keys yet.`,
    ...keys.map(k => `${productName(k.product)} license ID: ${k.id} (key ending in ${k.key.slice(-4)})`),
    `Send the buyer these keys from the Keygen dashboard.`,
  ].join('\n'));
}

/* "Works only in CyberRMF Integrate · valid until … · 1 machine", from what Keygen set on the license. */
function keyTerms(product, attributes, separator) {
  const parts = [`Works only in ${productName(product)}`];
  const expiry = attributes?.expiry ? new Date(attributes.expiry) : null;
  if (expiry && Number.isFinite(expiry.getTime())) {
    parts.push(`valid until ${expiry.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })}`);
  }
  const machines = Number(attributes?.maxMachines);
  if (machines > 0) parts.push(`${machines} machine${machines === 1 ? '' : 's'}`);
  return parts.join(separator);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SIGNUPS_OPEN) {
    return res.status(503).json({ error: 'Signups are closed for now. Please contact info@cyberrmf.com.' });
  }

  const missing = [];
  if (!KEYGEN_ACCOUNT_ID)  missing.push('KEYGEN_ACCOUNT_ID');
  if (!KEYGEN_ADMIN_TOKEN) missing.push('KEYGEN_ADMIN_TOKEN');
  missing.push(...missingPolicyEnv());
  if (!RESEND_API_KEY)     missing.push('RESEND_API_KEY');
  if (missing.length) {
    console.error('beta-signup: missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { firstName, lastName, email, pulseCapability, tools, benefit, comments } = req.body || {};

  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'First name, last name, and email are required' });
  }

  const fullName = `${firstName} ${lastName}`;
  const steps = [];

  try {
    /* ── 1. Create one license per app in Keygen ── */
    const metadata = {
      email,
      organization: '',
      role: '',
      pulseCapability: pulseCapability || '',
      tools: tools || '',
      benefit: benefit || '',
      comments: comments || '',
    };

    const integrate = await createLicense('integrate', fullName, metadata);
    if (!integrate.ok) {
      console.error('beta-signup: Keygen error (integrate):', JSON.stringify(integrate.body));
      return res.status(502).json({ error: 'Failed to create license' });
    }
    steps.push('license_created_integrate');

    // A purchase is both keys or neither: if the second license fails, the
    // first is deleted again so the buyer can simply try again. If that
    // delete fails too, info@cyberrmf.com is told which license to remove.
    // The buyer is never sent just one key.
    const adminTools = await createLicense('admin-tools', fullName, metadata);
    if (!adminTools.ok) {
      console.error('Keygen error (admin-tools):', JSON.stringify(adminTools.body));
      steps.push('license_failed_admin_tools');
      const orphanId = integrate.body.data.id;
      if (await deleteLicense(orphanId)) {
        steps.push('license_removed_integrate');
      } else {
        steps.push('license_remove_failed_integrate');
        console.error('Signup left an unsent CyberRMF Integrate license:', orphanId);
        await notifyInfo(`Signup failed halfway: ${fullName}`, [
          `The CyberRMF Admin Tools license for ${fullName} (${email}) could not be created, and the CyberRMF Integrate license created just before it could not be deleted.`,
          `Nothing was sent to the buyer, who was asked to try again.`,
          `Delete this license in the Keygen dashboard: ${orphanId}`,
        ].join('\n'));
      }
      console.error('beta-signup: stopped, no keys sent:', steps);
      return res.status(502).json({
        error: 'We could not set up your licenses, and nothing was sent to you. Please try again in a few minutes, or contact info@cyberrmf.com.',
      });
    }
    steps.push('license_created_admin_tools');

    const integrateKey = integrate.body.data.attributes.key;
    const adminToolsKey = adminTools.body.data.attributes.key;
    const keys = [
      { product: 'integrate', id: integrate.body.data.id, key: integrateKey, attributes: integrate.body.data.attributes },
      { product: 'admin-tools', id: adminTools.body.data.id, key: adminToolsKey, attributes: adminTools.body.data.attributes },
    ];

    /* ── 2. Send email to user via Resend ──
     * Gmail auto-collapses "repeated content" it has seen from the same
     * sender before. Two things we do to defeat that:
     *   1. Every visible section carries the license keys or a per-signup
     *      unique reference, so no two emails look identical.
     *   2. Critical activation instructions appear ABOVE the download
     *      links, so even if Gmail decided to hide something the user
     *      still sees what they need to actually activate.
     */
    const signupRef  = `${Date.now().toString(36).toUpperCase()}-${integrateKey.slice(0, 6)}`;
    const signupDate = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

    // RFC 2369 / RFC 8058 unsubscribe metadata.
    //   - mailto fallback is always present (works on every client)
    //   - if UNSUBSCRIBE_SECRET is set, we also include a signed HTTPS URL
    //     and enable List-Unsubscribe-Post for Gmail/Yahoo one-click
    const unsubMailto = `mailto:info@cyberrmf.com?subject=${encodeURIComponent('Unsubscribe: ' + email)}&body=${encodeURIComponent('Please remove ' + email + ' from all CyberRMF mailing lists. (Signup ref ' + signupRef + ')')}`;
    const unsubUrl    = buildUnsubUrl(email);              // null if secret missing
    const unsubLink   = unsubUrl || unsubMailto;           // what the visible button points to
    const listUnsubHeader = unsubUrl
      ? `<${unsubUrl}>, <${unsubMailto}>`
      : `<${unsubMailto}>`;
    const emailHeaders = { 'List-Unsubscribe': listUnsubHeader };
    if (unsubUrl) emailHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';

    const userEmailBody = {
      from: 'CyberRMF <no-reply@integratermf.com>',
      to: [email],
      subject: `Your CyberRMF license keys — ref ${signupRef}`,
      headers: emailHeaders,
      html: `
        <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:640px;margin:0 auto;">
          <h2 style="color:#60a5fa;margin:0 0 4px;">Welcome to CyberRMF, ${firstName}!</h2>
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

          <!-- ══════════ LICENSE KEYS (unique per-signup), one per app ══════════ -->
          <p style="font-size:12px;color:#9ca3af;margin:0 0 10px;line-height:1.5;">Each app has its own license key. Use each key only in the app it is labelled with.</p>
          ${keys.map(k => `
          <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:12px;">
            <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">${productName(k.product)} License Key</p>
            <p style="font-size:16px;font-weight:700;color:#60a5fa;margin:0;word-break:break-all;">${k.key}</p>
            <p style="font-size:11px;color:#6b7280;margin:8px 0 0;">${keyTerms(k.product, k.attributes, ' &middot; ')}.</p>
          </div>`).join('')}

          <!-- ══════════ WHAT TO DO NEXT (activation FIRST, before downloads) ══════════ -->
          <p style="font-size:14px;color:#e4e6eb;margin:24px 0 12px;font-weight:600;">How to activate on ${firstName ? firstName + "'s" : 'your'} machines (ref ${signupRef.slice(0, 8)}):</p>

          <!-- Option A — Online -->
          <div style="background:#1e2a3a;border:1px solid #2563eb;border-radius:6px;padding:16px;margin-bottom:14px;">
            <p style="font-size:11px;color:#60a5fa;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Option A &mdash; Online Activation</p>
            <p style="font-size:12px;color:#9ca3af;margin:0 0 10px;line-height:1.5;">
              Use this if the machine has internet access.
            </p>
            <ol style="font-size:13px;color:#e4e6eb;margin:0;padding-left:20px;line-height:1.75;">
              <li>Launch the app and click <strong>Online Activation</strong></li>
              <li>Paste the key for that app from above</li>
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
              <li>Choose the app at the top of the page, then enter the key for that app, your email, and the activation code</li>
              <li>Click <strong>Email My Response Code</strong>. We email a <strong>response code</strong> to this address</li>
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

          <!-- ══════════ COMPLIANCE FOOTER (CAN-SPAM / CASL / GDPR) ══════════ -->
          <hr style="border:none;border-top:1px solid #3a3f4b;margin:28px 0 16px;">
          <p style="font-size:11px;color:#6b7280;line-height:1.6;margin:0 0 10px;text-align:center;">
            You're receiving this because you requested CyberRMF licenses. This is a transactional message tied to that request.
            If you'd prefer not to receive any future CyberRMF emails (including product updates, release announcements, or product news),
            <a href="${unsubLink}" style="color:#60a5fa;text-decoration:underline;">unsubscribe here</a>.
          </p>
          <p style="font-size:10px;color:#4b5563;line-height:1.5;margin:10px 0 0;text-align:center;">
            ${BUSINESS_ADDRESS}<br/>
            <a href="https://integratermf.com/privacy.html" style="color:#6b7280;text-decoration:underline;">Privacy</a> &middot;
            <a href="https://integratermf.com/legal.html" style="color:#6b7280;text-decoration:underline;">Legal</a> &middot;
            <a href="https://integratermf.com/security.html" style="color:#6b7280;text-decoration:underline;">Security</a>
          </p>
        </div>
      `,
      text: [
        `Welcome to CyberRMF, ${firstName}!`,
        `Signup ref: ${signupRef}   |   ${signupDate}`,
        ``,
        `DOWNLOADS (Windows x64)`,
        `  Integrate:   ${DOWNLOAD_INTEGRATE}`,
        `  Admin Tools: ${DOWNLOAD_ADMIN}`,
        ``,
        `YOUR LICENSE KEYS (each app has its own key; use each key only in its app)`,
        ...keys.flatMap(k => [
          `  ${productName(k.product)}: ${k.key}`,
          `    (${keyTerms(k.product, k.attributes, ', ')})`,
        ]),
        ``,
        `HOW TO ACTIVATE`,
        ``,
        `Option A - Online Activation (for machines with internet):`,
        `  1. Launch the app and click "Online Activation"`,
        `  2. Paste the license key for that app`,
        `  3. Click "Activate License"`,
        ``,
        `Option B - Offline / Air-Gapped Activation (for isolated machines):`,
        `  1. Launch the app on the offline machine, click "Air-Gapped Activation"`,
        `  2. Write down the activation code the app displays`,
        `  3. On any online device, open: https://integratermf.com/activate`,
        `  4. Choose the app, then enter the key for that app, your email, and the activation code`,
        `  5. Click "Email My Response Code". We email a response code to this address`,
        `  6. Type the response code back into the offline app`,
        ``,
        `Questions? Reply to this email or contact info@cyberrmf.com`,
        `-- Signup ref ${signupRef} --`,
        ``,
        `--`,
        `You're receiving this because you requested CyberRMF licenses.`,
        `To unsubscribe from all future CyberRMF emails, visit:`,
        `  ${unsubLink}`,
        `(or reply "UNSUBSCRIBE", or email ${unsubMailto})`,
        ``,
        `${BUSINESS_ADDRESS.replace(/&middot;/g, '-')}`,
        `Privacy: https://integratermf.com/privacy.html`,
        `Legal: https://integratermf.com/legal.html`,
      ].join('\n'),
    };

    let emailRes;
    try {
      emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(userEmailBody),
      });
    } catch (sendErr) {
      steps.push('user_email_error');
      await notifyWelcomeEmailFailed(fullName, email, keys);
      throw sendErr;
    }

    const emailResBody = await emailRes.text();

    if (!emailRes.ok) {
      steps.push('user_email_failed');
      console.error('beta-signup: welcome email failed:', emailRes.status, emailResBody, 'steps:', steps);
      await notifyWelcomeEmailFailed(fullName, email, keys);
      return res.status(200).json({
        success: false,
        error: 'Licenses created but email failed',
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
          subject: `New Signup: ${fullName}`,
          html: `
            <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:24px;border-radius:8px;max-width:600px;">
              <h2 style="color:#60a5fa;margin:0 0 16px;">New License Request</h2>
              <table style="font-size:13px;border-collapse:collapse;width:100%;">
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Name</td><td style="padding:6px 0;">${fullName}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Email</td><td style="padding:6px 0;"><a href="mailto:${email}" style="color:#60a5fa;">${email}</a></td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Pulse Capability</td><td style="padding:6px 0;">${pulseCapability || 'N/A'}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Tools</td><td style="padding:6px 0;">${tools || 'N/A'}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Benefit</td><td style="padding:6px 0;">${benefit || 'N/A'}</td></tr>
                <tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">Comments</td><td style="padding:6px 0;">${comments || 'N/A'}</td></tr>
                ${keys.map(k => `<tr><td style="color:#9ca3af;padding:6px 12px 6px 0;white-space:nowrap;">${productName(k.product)} Key</td><td style="padding:6px 0;color:#22c55e;font-weight:700;word-break:break-all;">${k.key}</td></tr>`).join('')}
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

    /* ── 4. Add contact to Resend Audience (soft-fail) ──
     * This lets future broadcasts automatically skip people who later
     * unsubscribe, and gives /api/unsubscribe a contact to flip. If
     * RESEND_AUDIENCE_ID isn't set, this is skipped silently.
     */
    if (RESEND_AUDIENCE_ID) {
      try {
        const contactRes = await fetch(
          `https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email,
              first_name: firstName,
              last_name: lastName,
              unsubscribed: false,
            }),
          }
        );
        if (contactRes.ok || contactRes.status === 409) {
          // 409 = already in audience (re-signup), treat as success
          steps.push('contact_added');
        } else {
          const contactErrBody = await contactRes.text();
          console.warn('Resend contact creation failed:', contactRes.status, contactErrBody);
          steps.push('contact_failed');
        }
      } catch (contactErr) {
        console.error('Resend contact creation error:', contactErr);
        steps.push('contact_error');
      }
    } else {
      steps.push('contact_skipped_no_audience_id');
    }

    console.log('beta-signup: done:', steps);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Beta signup error:', err, 'steps:', steps);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
