import crypto from 'crypto';

/*
 * Air-gapped selective deactivation.
 *
 * Flow:
 *   1. On the air-gapped machine, the user generates a deactivation code
 *      in the app: 20 Crockford base32 characters, XXXXX-XXXXX-XXXXX-XXXXX.
 *      Must match getDeactivationCode in the app's shared/ipc/keygen.ts.
 *        - Activated air-gapped: Keygen's fingerprint for the machine is
 *          its activation code, which is the first 20 hex of
 *          SHA-256("cyberrmf-ac-v3|" + deactivationCode). The code is a
 *          secret only that machine knows; we hash it and compare.
 *        - Activated online: Keygen's fingerprint is the 64-hex hardware
 *          fingerprint, and the code is the first 20 base32 characters of
 *          SHA-256("cyberrmf-dc-online-v3|" + fingerprint).
 *
 *   2. The user comes to integratermf.com/deactivate (Air-Gapped tab) with:
 *        { key, email, deactivationCode }
 *
 *   3. This endpoint:
 *        a. Validates the license & verifies the email matches.
 *        b. Lists every machine currently attached to the license.
 *        c. Checks the code against each machine's stored fingerprint, both
 *           ways above, using a timing-safe compare.
 *        d. Deletes only the matching machine (surgical release of a
 *           single slot). If the user has more than one active machine and
 *           wants to release them all, they should use the Online tab.
 *
 *   No secret is needed here or in the app.
 */

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;

const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function stripFormat(s) {
  return String(s || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/* What the user typed, as Crockford base32: O read as 0, I and L as 1. */
function normalizeBase32(s) {
  return stripFormat(s).replace(/O/g, '0').replace(/[IL]/g, '1');
}

function normalizeLicenseKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function toBase32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xFFF;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function codeReleasesMachine(code, machineFingerprint) {
  const fp = String(machineFingerprint || '');
  if (/^[0-9A-F]{20}$/i.test(fp)) {
    const expected = crypto.createHash('sha256').update(`cyberrmf-ac-v3|${code}`).digest('hex').slice(0, 20).toUpperCase();
    return codesMatch(fp.toUpperCase(), expected);
  }
  if (/^[0-9a-f]{64}$/i.test(fp)) {
    const expected = toBase32(crypto.createHash('sha256').update(`cyberrmf-dc-online-v3|${fp.toLowerCase()}`).digest()).slice(0, 20);
    return codesMatch(code, expected);
  }
  return false;
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
  if (missing.length) {
    console.error('Missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error', debug: `Missing: ${missing.join(', ')}` });
  }

  const { key, email, deactivationCode } = req.body || {};
  if (!key || !email || !deactivationCode) {
    return res.status(400).json({ error: 'License key, email, and deactivation code are all required.' });
  }

  const normalizedKey  = normalizeLicenseKey(key);
  const strippedCode   = normalizeBase32(deactivationCode);

  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(strippedCode)) {
    return res.status(400).json({ error: 'The deactivation code should be 20 characters in groups of 5. Copy the entire code shown by the app.' });
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

    /* ── 3. Find the machine the code belongs to ── */
    let match = null;
    for (const m of machines) {
      if (codeReleasesMachine(strippedCode, m?.attributes?.fingerprint)) {
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
