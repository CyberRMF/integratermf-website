import crypto from 'crypto';

/*
 * Air-gapped selective deactivation.
 *
 * Flow:
 *   1. On the air-gapped machine, the user generates a deactivation code
 *      in the app. The code is:
 *
 *        HMAC(AIRGAP_SECRET, "deactivate|" + machineFingerprintAsStoredInKeygen)
 *          .slice(0, 20).toUpperCase()  formatted as XXXX-XXXX-XXXX-XXXX-XXXX
 *
 *      `machineFingerprintAsStoredInKeygen` is either the raw SHA-256
 *      hardware fingerprint (if the machine was activated online) or the
 *      stripped activation code (if it was activated air-gapped). The app
 *      knows which by consulting its local .license.json's `mode` field.
 *
 *   2. The user comes to integratermf.com/deactivate (Air-Gapped tab) with:
 *        { key, email, deactivationCode }
 *
 *   3. This endpoint:
 *        a. Validates the license & verifies the email matches.
 *        b. Lists every machine currently attached to the license.
 *        c. Re-derives the expected deactivation code from each machine's
 *           stored fingerprint and compares to the one the user provided
 *           using a timing-safe compare.
 *        d. Deletes only the matching machine (surgical release of a
 *           single slot). If the user has more than one active machine and
 *           wants to release them all, they should use the Online tab.
 *
 *   The deactivation code alone does not carry the fingerprint — the
 *   fingerprint stays on the machine. The server only ever holds the
 *   *hash* under an HMAC keyed with the shared secret, which is enough to
 *   prove the request came from the physical machine.
 */

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const AIRGAP_SECRET      = process.env.AIRGAP_SECRET;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;

function stripFormat(s) {
  return String(s || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function normalizeLicenseKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function expectedDeactivationCode(machineFingerprint) {
  return crypto
    .createHmac('sha256', AIRGAP_SECRET)
    .update(`deactivate|${machineFingerprint}`)
    .digest('hex')
    .slice(0, 20)
    .toUpperCase();
}

function codesMatch(userStripped, expectedStripped) {
  if (userStripped.length !== expectedStripped.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(userStripped, 'utf8'),
      Buffer.from(expectedStripped, 'utf8')
    );
  } catch {
    return false;
  }
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

  const { key, email, deactivationCode } = req.body || {};
  if (!key || !email || !deactivationCode) {
    return res.status(400).json({ error: 'License key, email, and deactivation code are all required.' });
  }

  const normalizedKey  = normalizeLicenseKey(key);
  const strippedCode   = stripFormat(deactivationCode);

  if (strippedCode.length < 16) {
    return res.status(400).json({ error: 'Deactivation code appears to be too short. Copy the entire code shown by the app.' });
  }

  try {
    /* ── 1. Find the license id & verify email ── */
    const validateRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses/actions/validate-key`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Accept: 'application/vnd.api+json',
        },
        body: JSON.stringify({ meta: { key: normalizedKey } }),
      }
    );
    const validateJson = await validateRes.json();
    const licenseId    = validateJson?.data?.id;
    const licenseEmail = validateJson?.data?.attributes?.metadata?.email;

    if (!licenseId) {
      return res.status(404).json({ error: 'License key not found. Double-check for typos.' });
    }
    if (licenseEmail && String(licenseEmail).toLowerCase() !== String(email).toLowerCase()) {
      return res.status(403).json({ error: 'Email does not match the address the license was issued to.' });
    }

    /* ── 2. List machines attached to this license ── */
    const machinesRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/machines?filter[license]=${licenseId}&limit=100`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${KEYGEN_ADMIN_TOKEN}`,
          Accept: 'application/vnd.api+json',
        },
      }
    );
    const machinesJson = await machinesRes.json();
    if (!machinesRes.ok) {
      const detail = machinesJson?.errors?.[0]?.detail || 'Failed to list machines';
      console.error('Keygen machines list error:', machinesRes.status, machinesJson);
      return res.status(502).json({ error: detail });
    }
    const machines = Array.isArray(machinesJson?.data) ? machinesJson.data : [];

    if (machines.length === 0) {
      return res.status(200).json({
        success: true,
        machinesRemoved: 0,
        message: 'This license currently has no active machines. Nothing to release.',
      });
    }

    /* ── 3. Find the machine whose HMAC(SECRET, "deactivate|" + fingerprint) matches ── */
    let match = null;
    for (const m of machines) {
      const fp = m?.attributes?.fingerprint || '';
      if (!fp) continue;
      const expected = expectedDeactivationCode(fp);
      if (codesMatch(strippedCode, expected)) {
        match = m;
        break;
      }
    }

    if (!match) {
      return res.status(404).json({
        error: 'That deactivation code does not match any active machine under this license. Double-check that the code was generated on the same machine you want to release, and that the license key and email are correct.'
      });
    }

    /* ── 4. Delete the matching machine ── */
    const delRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/machines/${match.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${KEYGEN_ADMIN_TOKEN}`,
          Accept: 'application/vnd.api+json',
        },
      }
    );
    if (delRes.status !== 204 && !delRes.ok) {
      const delBody = await delRes.json().catch(() => ({}));
      const detail = delBody?.errors?.[0]?.detail || `Failed to delete machine (HTTP ${delRes.status})`;
      console.error('Keygen machine delete error:', delRes.status, delBody);
      return res.status(502).json({ error: detail });
    }

    /* ── 5. Best-effort receipt ── */
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
            subject: 'CyberRMF Air-Gapped Deactivation Confirmation',
            html: `
              <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
                <h2 style="color:#a78bfa;margin:0 0 8px;">Machine Released</h2>
                <p style="color:#9ca3af;font-size:13px;margin:0 0 20px;">
                  The air-gapped machine that generated the deactivation code below has been released from your license. You can now activate a new machine using the same license key.
                </p>
                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:16px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">License Key</p>
                  <p style="font-size:14px;font-weight:700;color:#a78bfa;margin:0;word-break:break-all;">${normalizedKey}</p>
                </div>
                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:16px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Machine Name</p>
                  <p style="font-size:13px;color:#e5e7eb;margin:0;word-break:break-all;">${match.attributes?.name || match.id}</p>
                </div>
                <p style="font-size:12px;color:#6b7280;margin:20px 0 0;text-align:center;">
                  Questions? <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
                </p>
              </div>
            `,
          }),
        });
      } catch (mailErr) {
        console.error('Airgap deactivation receipt failed (non-fatal):', mailErr);
      }
    }

    return res.status(200).json({
      success: true,
      machinesRemoved: 1,
      machineName: match.attributes?.name || null,
      message: 'Machine released. You can now activate a new machine using this license key.',
    });

  } catch (err) {
    console.error('deactivate-airgap error:', err);
    return res.status(500).json({ error: 'Internal server error', debug: err?.message });
  }
}
