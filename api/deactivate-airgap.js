import crypto from 'crypto';
import { clientIp, takeToken, tooManyRequests } from './_rate-limit.js';
import { missingPolicyEnv, productProblem, wrongProductProblem } from './_products.js';
import { sendReleaseNotice } from './_release-notice.js';

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
 *   2. The user comes to integratermf.com/license (Air-Gapped tab),
 *      chooses the app, and enters:
 *        { product, key, email, deactivationCode }
 *
 *   3. This endpoint:
 *        a. Validates the license, checks it is under the chosen app's
 *           policy & verifies the email matches (a license with no email
 *           on file is refused).
 *        b. Lists every machine currently attached to the license.
 *        c. Checks the code against each machine's stored fingerprint, both
 *           ways above, using a timing-safe compare.
 *        d. Deletes only the matching machine (surgical release of a
 *           single slot). If the user has more than one active machine and
 *           wants to release them all, they should use the Online tab.
 *        e. Best-effort release notice to the address on the license.
 *
 *   No secret is needed here or in the app. No emailed confirmation code
 *   either: the deactivation code already proves the request comes from
 *   that machine.
 */

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;

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
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wait = takeToken('deactivate-airgap', clientIp(req), 10, 10 * 60 * 1000);
  if (wait) return tooManyRequests(res, wait);

  const missing = [];
  if (!KEYGEN_ACCOUNT_ID)  missing.push('KEYGEN_ACCOUNT_ID');
  if (!KEYGEN_ADMIN_TOKEN) missing.push('KEYGEN_ADMIN_TOKEN');
  missing.push(...missingPolicyEnv());
  if (missing.length) {
    console.error('deactivate-airgap: missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { product, key, email, deactivationCode } = req.body || {};
  const badProduct = productProblem(product);
  if (badProduct) return res.status(badProduct.status).json({ error: badProduct.error });
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
    const licensePolicy = validateJson?.data?.relationships?.policy?.data?.id;

    if (!licenseId) {
      return res.status(404).json({ error: 'License key not found. Double-check for typos.' });
    }
    const wrongProduct = wrongProductProblem(product, licensePolicy);
    if (wrongProduct) {
      return res.status(wrongProduct.status).json({ error: wrongProduct.error });
    }
    if (!licenseEmail) {
      return res.status(409).json({ error: 'This license has no email address on file, so we cannot check that it is yours. Please contact info@cyberrmf.com.' });
    }
    if (String(licenseEmail).trim().toLowerCase() !== String(email).trim().toLowerCase()) {
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

    /* ── 5. Best-effort release notice ── */
    await sendReleaseNotice({
      to: licenseEmail,
      product,
      key: normalizedKey,
      released: 1,
      machineName: match.attributes?.name || match.id,
      how: 'Air-Gapped Deactivation, on integratermf.com',
    });

    return res.status(200).json({
      success: true,
      machinesRemoved: 1,
      machineName: match.attributes?.name || null,
      message: 'Machine released. You can now activate a new machine using this license key.',
    });

  } catch (err) {
    console.error('deactivate-airgap error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
