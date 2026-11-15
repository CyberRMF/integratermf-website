import crypto from 'crypto';
import { clientIp, takeToken, tooManyRequests } from './_rate-limit.js';
import { escapeHtml, maskEmail } from './_confirm.js';
import { missingPolicyEnv, productName, productProblem, wrongProductProblem } from './_products.js';

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const AIRGAP_SIGNING_KEY = process.env.AIRGAP_SIGNING_KEY;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;

const TEN_MINUTES = 10 * 60 * 1000;

/*
 * Air-gapped activation flow:
 *   1. User launches Integrate / Admin Tools on an offline machine.
 *   2. App displays an activation code derived from its hardware fingerprint.
 *   3. User visits integratermf.com/deactivate on any online device, chooses
 *      the app and enters { product, key, email, activationCode } in the
 *      "Air-Gapped Activation" tab.
 *   4. This endpoint:
 *        a. Verifies the license exists in Keygen, is under the chosen app's
 *           policy and belongs to the given email (a license with no email
 *           on file is refused: there is nowhere to send the code), and that
 *           Keygen would accept this machine.
 *        b. Registers a Keygen machine whose fingerprint == activationCode
 *           (or reuses one if already registered — idempotent).
 *        c. Signs a response code bound to (product, activationCode,
 *           licenseKey, end date) with the Ed25519 private key in
 *           AIRGAP_SIGNING_KEY.
 *        d. Emails the response code to the address on the license and
 *           replies with that address, masked. The reply never contains the
 *           response code.
 *   5. User types the response code into the offline app; the app checks the
 *      signature with the public key built into it and unlocks.
 *
 * The response code is *not* a license transport — it's an offline proof that
 * this specific machine + this specific license was accepted by Keygen.
 * Only this server can make one: the app holds no secret. It can't be
 * revoked remotely, which is why it only ever goes to the license's email.
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

/*
 * Fixed reference point for the day counts in a response code. Must match
 * AIRGAP_EPOCH_MS in the app's shared/ipc/keygen.ts.
 */
const AIRGAP_EPOCH_MS = Date.UTC(2020, 0, 1);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* Crockford base32, matching the app. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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

let signingKey;
function airgapSigningKey() {
  if (!signingKey) {
    signingKey = crypto.createPrivateKey({ key: Buffer.from(AIRGAP_SIGNING_KEY, 'base64'), format: 'der', type: 'pkcs8' });
  }
  return signingKey;
}

/**
 * v4 response code. Must match verifyResponseCode in the app's
 * shared/ipc/keygen.ts.
 *   bytes 0-1   end date, days since 2020-01-01 (big-endian)
 *   bytes 2-3   issue date, same encoding
 *   bytes 4-67  Ed25519 signature over
 *               "cyberrmf-response-v4|<product>|<activation code>|<license key>|<end day>|<issue day>"
 *               where <product> is 'integrate' or 'admin-tools'
 * written as 109 base32 characters plus 1 check character (a hash of the
 * 68 bytes), in 22 groups of 5.
 *
 * The end date is signed alongside (product, ac, key) so re-pasting the code
 * after it expires does NOT reset the local validity window in the app, and
 * a code made for one app doesn't verify in the other.
 */
function computeResponseCodeV4(product, activationCode, licenseKey, expiryEpochDays, issuedEpochDays) {
  const ac = stripFormat(activationCode);
  const lk = normalizeLicenseKey(licenseKey);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(expiryEpochDays, 0);
  head.writeUInt16BE(issuedEpochDays, 2);
  const message = Buffer.from(`cyberrmf-response-v4|${product}|${ac}|${lk}|${expiryEpochDays}|${issuedEpochDays}`, 'utf8');
  const bytes = Buffer.concat([head, crypto.sign(null, message, airgapSigningKey())]);
  const check = BASE32[crypto.createHash('sha256').update(bytes).digest()[0] & 31];
  return formatGroups(toBase32(bytes) + check, 5);
}

/*
 * Keygen validation codes that stop an activation. NO_MACHINE(S) (no
 * machines yet) and FINGERPRINT_SCOPE_MISMATCH (machines, but not this one)
 * don't say whether a slot is free: step b registers the machine and
 * Keygen enforces the limit there, as the app does for online activation.
 */
function validationProblem(meta) {
  if (!meta || meta.valid) return null;
  switch (meta.code) {
    case 'NO_MACHINE':
    case 'NO_MACHINES':
    case 'FINGERPRINT_SCOPE_MISMATCH':
    case 'VALID':
      return null;
    case 'MACHINE_LIMIT_EXCEEDED':
      return { status: 409, error: 'This license has already been activated on the maximum number of machines. Deactivate an existing machine first.' };
    case 'EXPIRED':
      return { status: 410, error: 'This license has expired.' };
    case 'SUSPENDED':
      return { status: 403, error: 'This license has been suspended.' };
    default:
      return { status: 400, error: meta.detail || `License validation failed (${meta.code})` };
  }
}

/*
 * The only way a response code leaves this server. `to` must be the
 * address stored on the license. Returns true when Resend accepted it.
 */
async function sendResponseCodeEmail({ to, product, responseCode, activationCode, keyEnd, lastDay }) {
  const app = productName(product);
  const rows = [
    ['App', app],
    ['Made for activation code', activationCode],
    ['License key ending in', keyEnd],
    ['Last day of the license', lastDay],
  ];
  const howTo = `On the air-gapped machine, open ${app} and choose Air-Gapped Activation (or License Management, Activate License, Air-Gapped). Enter your license key and this response code, then click Complete Activation. O and 0 count as the same character, as do I, L and 1.`;
  const notYou = `Didn't ask for this? Check the activation code above. If it isn't from one of your machines, someone who knows your license key and email has used one of its machine slots, although only you received this code. Contact info@cyberrmf.com and we'll release that machine, or release every machine yourself at integratermf.com/deactivate (Online Deactivation).`;
  const rowsHtml = rows.map(([label, value]) => `
                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:12px 16px;margin-bottom:12px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(label)}</p>
                  <p style="font-size:14px;color:#e5e7eb;margin:0;font-family:monospace;letter-spacing:0.04em;word-break:break-all;">${escapeHtml(value)}</p>
                </div>`).join('');

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'CyberRMF <no-reply@integratermf.com>',
        to: [to],
        subject: `Your ${app} response code`,
        // A new value on every email stops Gmail from threading the codes
        // together and hiding the newest one.
        headers: { 'X-Entity-Ref-ID': crypto.randomUUID() },
        html: `
              <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
                <h2 style="color:#a78bfa;margin:0 0 8px;">Your Response Code</h2>
                <p style="color:#9ca3af;font-size:13px;margin:0 0 20px;">Someone asked on integratermf.com for a response code to activate ${escapeHtml(app)} on an air-gapped machine. Here it is.</p>
                <div style="background:#23272e;border:2px solid #a78bfa;border-radius:6px;padding:16px;margin-bottom:20px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Response Code (${escapeHtml(app)})</p>
                  <p style="font-size:15px;font-weight:700;color:#a78bfa;margin:0;font-family:monospace;letter-spacing:0.06em;line-height:1.7;word-break:normal;overflow-wrap:break-word;">${escapeHtml(responseCode)}</p>
                  <p style="font-size:11px;color:#6b7280;margin:8px 0 0;">It only works in ${escapeHtml(app)}, on the machine with the activation code below, with this license key.</p>
                </div>${rowsHtml}
                <p style="font-size:12px;color:#e5e7eb;margin:8px 0 20px;line-height:1.6;">${escapeHtml(howTo)} After the last day of the license, the app needs a new response code.</p>
                <div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:6px;padding:12px 16px;margin-bottom:20px;">
                  <p style="font-size:12px;color:#fde68a;margin:0;line-height:1.6;">${escapeHtml(notYou)}</p>
                </div>
                <p style="font-size:12px;color:#6b7280;margin:20px 0 0;text-align:center;">
                  Questions? <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
                </p>
              </div>
            `,
        text: [
          `Your ${app} response code`,
          '',
          responseCode,
          '',
          ...rows.map(([label, value]) => `${label}: ${value}`),
          '',
          howTo,
          'After the last day of the license, the app needs a new response code.',
          '',
          notYou,
        ].join('\n'),
      }),
    });
    if (!emailRes.ok) {
      console.error('Response code email failed:', emailRes.status, await emailRes.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (mailErr) {
    console.error('Response code email failed:', mailErr);
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wait = takeToken('activate-airgap', clientIp(req), 10, TEN_MINUTES);
  if (wait) return tooManyRequests(res, wait);

  const missing = [];
  if (!KEYGEN_ACCOUNT_ID)  missing.push('KEYGEN_ACCOUNT_ID');
  if (!KEYGEN_ADMIN_TOKEN) missing.push('KEYGEN_ADMIN_TOKEN');
  if (!AIRGAP_SIGNING_KEY) missing.push('AIRGAP_SIGNING_KEY');
  if (!RESEND_API_KEY)     missing.push('RESEND_API_KEY');
  missing.push(...missingPolicyEnv());
  if (missing.length) {
    console.error('activate-airgap: missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error' });
  }
  try {
    airgapSigningKey();
  } catch (keyErr) {
    console.error('activate-airgap: AIRGAP_SIGNING_KEY is not a valid Ed25519 private key:', keyErr?.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { product, key, email, activationCode } = req.body || {};

  const badProduct = productProblem(product);
  if (badProduct) return res.status(badProduct.status).json({ error: badProduct.error });

  if (!key || !email || !activationCode) {
    return res.status(400).json({ error: 'License key, email, and activation code are required' });
  }

  const normalizedKey = normalizeLicenseKey(key);
  const fingerprint   = stripFormat(activationCode); // used as Keygen fingerprint

  if (!/^[0-9A-F]{20}$/.test(fingerprint)) {
    return res.status(400).json({ error: 'The activation code should be 20 characters (0-9 and A-F). Copy the entire code shown by the app.' });
  }

  try {
    /* ── 1. Validate the license key against Keygen with the activation code
             as the machine fingerprint. This tells us:
               - the key is real
               - whether a machine with this fingerprint is already activated
               - whether the license is expired or suspended ── */
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
    const licenseExpiry = validateJson?.data?.attributes?.expiry; // ISO string or null
    const licensePolicy = validateJson?.data?.relationships?.policy?.data?.id;

    if (!licenseId) {
      return res.status(404).json({ error: 'License key not found. Double-check for typos.' });
    }

    const wrongProduct = wrongProductProblem(product, licensePolicy);
    if (wrongProduct) {
      return res.status(wrongProduct.status).json({ error: wrongProduct.error });
    }

    // Verify the requester actually owns this key. Fails closed: with no
    // email on file there is nowhere to send the response code.
    if (!licenseEmail) {
      return res.status(409).json({ error: 'This license has no email address on file, so we cannot send a response code. Please contact info@cyberrmf.com.' });
    }
    if (String(licenseEmail).trim().toLowerCase() !== String(email).trim().toLowerCase()) {
      return res.status(403).json({ error: 'Email does not match the address the license was issued to.' });
    }

    const licenseProblem = validationProblem(meta);
    if (licenseProblem) {
      return res.status(licenseProblem.status).json({ error: licenseProblem.error });
    }

    // The response code carries the license's end date, and the app can't be
    // told a different one later, so never invent one.
    const expiryMs = licenseExpiry ? new Date(licenseExpiry).getTime() : NaN;
    if (!Number.isFinite(expiryMs)) {
      console.error('activate-airgap: license has no end date in Keygen:', licenseId);
      return res.status(409).json({ error: 'This license has no end date on file, so we cannot make a response code. Please contact info@cyberrmf.com.' });
    }

    // Every request that gets this far emails the license's owner.
    const sendWait = takeToken('airgap-email', normalizedKey, 5, TEN_MINUTES);
    if (sendWait) return tooManyRequests(res, sendWait);

    /* ── 2. If this machine isn't on the license yet, register it. Keygen
             refuses (422) when the license has no free slot. ── */
    if (meta && !meta.valid) {
      if (meta.code === 'NO_MACHINE' || meta.code === 'NO_MACHINES' || meta.code === 'FINGERPRINT_SCOPE_MISMATCH') {
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
      }
    }

    /* ── 3. Sign the offline response code (v4 with the license's end date from Keygen). ── */
    const expiryEpochDays = Math.max(0, Math.min(0xFFFF, Math.floor((expiryMs - AIRGAP_EPOCH_MS) / MS_PER_DAY)));
    // Round expiryMs to match what the app will derive from expiryEpochDays
    // (so the display date matches exactly on both sides).
    const canonicalExpiryMs = AIRGAP_EPOCH_MS + expiryEpochDays * MS_PER_DAY;
    const issuedEpochDays = Math.max(0, Math.min(0xFFFF, Math.floor((Date.now() - AIRGAP_EPOCH_MS) / MS_PER_DAY)));
    const responseCode = computeResponseCodeV4(product, fingerprint, normalizedKey, expiryEpochDays, issuedEpochDays);
    // The end day is a UTC day, as the app shows it.
    const lastDay = new Date(canonicalExpiryMs).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });

    /* ── 4. Email it to the address on the license. The machine stays
             registered if this fails, and asking again is safe (step 2 is
             idempotent), so the page just asks the user to try again. ── */
    const sent = await sendResponseCodeEmail({
      to: licenseEmail,
      product,
      responseCode,
      activationCode: formatGroups(fingerprint, 4),
      keyEnd: normalizedKey.slice(-4),
      lastDay,
    });
    if (!sent) {
      return res.status(502).json({ error: 'We could not send the email with your response code. Please try again in a few minutes, or contact info@cyberrmf.com.' });
    }

    const sentTo = maskEmail(licenseEmail);
    return res.status(200).json({
      sentTo,
      message: `We emailed your response code to ${sentTo}. Enter it in ${productName(product)} on the air-gapped machine. It can take a few minutes; check your spam folder.`,
    });

  } catch (err) {
    console.error('activate-airgap error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
