import crypto from 'crypto';

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const AIRGAP_SECRET      = process.env.AIRGAP_SECRET;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;

/*
 * Air-gapped activation flow:
 *   1. User launches Integrate / Admin Tools on an offline machine.
 *   2. App displays an activation code derived from its hardware fingerprint.
 *   3. User visits integratermf.com/deactivate on any online device and enters
 *      { licenseKey, email, activationCode } in the "Air-Gapped Activation" tab.
 *   4. This endpoint:
 *        a. Verifies license exists in Keygen and belongs to the given email.
 *        b. Registers a Keygen machine whose fingerprint == activationCode
 *           (or reuses one if already registered — idempotent).
 *        c. Computes an HMAC response code bound to (activationCode, licenseKey).
 *        d. Returns the response code (and optionally emails it as a receipt).
 *   5. User types the response code into the offline app; the app verifies the
 *      HMAC with the same shared secret and unlocks.
 *
 * The response code is *not* a license transport — it's an offline proof that
 * this specific machine + this specific license was accepted by Keygen.
 */

function stripFormat(s) {
  return String(s || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function normalizeLicenseKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function formatGroups(hex, groupSize = 4) {
  const re = new RegExp(`.{1,${groupSize}}`, 'g');
  return (hex.match(re) || []).join('-');
}

function computeResponseCode(activationCode, licenseKey) {
  const ac = stripFormat(activationCode);
  const lk = normalizeLicenseKey(licenseKey);
  const raw = crypto
    .createHmac('sha256', AIRGAP_SECRET)
    .update(`response|${ac}|${lk}`)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return formatGroups(raw, 4);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const missing = [];
  if (!KEYGEN_ACCOUNT_ID)  missing.push('KEYGEN_ACCOUNT_ID');
  if (!KEYGEN_ADMIN_TOKEN) missing.push('KEYGEN_ADMIN_TOKEN');
  if (!AIRGAP_SECRET)      missing.push('AIRGAP_SECRET');
  if (missing.length) {
    console.error('Missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error', debug: `Missing: ${missing.join(', ')}` });
  }

  const { key, email, activationCode } = req.body || {};

  if (!key || !email || !activationCode) {
    return res.status(400).json({ error: 'License key, email, and activation code are required' });
  }

  const normalizedKey = normalizeLicenseKey(key);
  const fingerprint   = stripFormat(activationCode); // used as Keygen fingerprint

  if (fingerprint.length < 16) {
    return res.status(400).json({ error: 'Activation code appears to be too short. Copy the entire code shown by the app.' });
  }

  try {
    /* ── 1. Validate the license key against Keygen with the activation code
             as the machine fingerprint. This tells us:
               - the key is real
               - whether a machine with this fingerprint is already activated
               - whether the pool has room for a new machine ── */
    const validateBody = JSON.stringify({
      meta: {
        key: normalizedKey,
        scope: { fingerprint },
      },
    });

    const validateRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses/actions/validate-key`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Accept: 'application/vnd.api+json',
        },
        body: validateBody,
      }
    );

    const validateJson = await validateRes.json();
    const meta         = validateJson?.meta;
    const licenseId    = validateJson?.data?.id;
    const licenseEmail = validateJson?.data?.attributes?.metadata?.email;

    if (!licenseId) {
      return res.status(404).json({ error: 'License key not found. Double-check for typos.' });
    }

    // Verify the requester actually owns this key
    if (licenseEmail && String(licenseEmail).toLowerCase() !== String(email).toLowerCase()) {
      return res.status(403).json({ error: 'Email does not match the address the license was issued to.' });
    }

    /* ── 2. If Keygen says NO_MACHINE(S), register one with this fingerprint.
             If it says FINGERPRINT_SCOPE_MISMATCH we're already over the machine
             limit for a different fingerprint. ── */
    if (meta && !meta.valid) {
      if (meta.code === 'NO_MACHINE' || meta.code === 'NO_MACHINES') {
        const activateBody = JSON.stringify({
          data: {
            type: 'machines',
            attributes: {
              fingerprint,
              name: `Air-gapped (${fingerprint.slice(0, 8)})`,
              platform: 'air-gapped',
            },
            relationships: {
              license: { data: { type: 'licenses', id: licenseId } },
            },
          },
        });

        const activateRes = await fetch(
          `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/machines`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${KEYGEN_ADMIN_TOKEN}`,
              'Content-Type': 'application/vnd.api+json',
              Accept: 'application/vnd.api+json',
            },
            body: activateBody,
          }
        );

        if (!activateRes.ok && activateRes.status !== 409 /* conflict = already registered */) {
          const errBody = await activateRes.json().catch(() => ({}));
          const detail = errBody?.errors?.[0]?.detail || 'Failed to register machine';
          console.error('Keygen machine create error:', activateRes.status, errBody);
          if (activateRes.status === 422) {
            return res.status(409).json({ error: `Activation limit reached for this license. ${detail}` });
          }
          return res.status(502).json({ error: detail });
        }
      } else if (meta.code === 'FINGERPRINT_SCOPE_MISMATCH' || meta.code === 'MACHINE_LIMIT_EXCEEDED') {
        return res.status(409).json({
          error: 'This license has already been activated on the maximum number of machines. Deactivate an existing machine first.'
        });
      } else if (meta.code === 'EXPIRED') {
        return res.status(410).json({ error: 'This license has expired.' });
      } else if (meta.code === 'SUSPENDED') {
        return res.status(403).json({ error: 'This license has been suspended.' });
      } else if (meta.code !== 'VALID') {
        return res.status(400).json({ error: meta.detail || `License validation failed (${meta.code})` });
      }
    }

    /* ── 3. Compute the offline response code. ── */
    const responseCode = computeResponseCode(fingerprint, normalizedKey);

    /* ── 4. Best-effort email receipt (never fail the request on this). ── */
    if (RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'CyberRMF <no-reply@integratermf.com>',
            to: [email],
            subject: 'Your CyberRMF Air-Gapped Response Code',
            html: `
              <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
                <h2 style="color:#a78bfa;margin:0 0 8px;">Air-Gapped Activation Successful</h2>
                <p style="color:#9ca3af;font-size:13px;margin:0 0 24px;">Enter the response code below in the CyberRMF application on your air-gapped machine to finish activation.</p>

                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:20px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Activation Code (from your machine)</p>
                  <p style="font-size:14px;color:#e5e7eb;margin:0;font-family:monospace;letter-spacing:0.08em;word-break:break-all;">${fingerprint.match(/.{1,4}/g).join('-')}</p>
                </div>

                <div style="background:#23272e;border:2px solid #a78bfa;border-radius:6px;padding:16px;margin-bottom:20px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Response Code</p>
                  <p style="font-size:18px;font-weight:700;color:#a78bfa;margin:0;font-family:monospace;letter-spacing:0.1em;word-break:break-all;">${responseCode}</p>
                  <p style="font-size:11px;color:#6b7280;margin:8px 0 0;">This code is bound to your machine and license key. It only works in the CyberRMF app.</p>
                </div>

                <p style="font-size:12px;color:#6b7280;margin:24px 0 0;text-align:center;">
                  Questions? <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
                </p>
              </div>
            `,
          }),
        });
      } catch (mailErr) {
        console.error('Airgap email send failed (non-fatal):', mailErr);
      }
    }

    return res.status(200).json({
      success: true,
      responseCode,
      activationCode: fingerprint.match(/.{1,4}/g).join('-'),
    });

  } catch (err) {
    console.error('activate-airgap error:', err);
    return res.status(500).json({ error: 'Internal server error', debug: err?.message });
  }
}
