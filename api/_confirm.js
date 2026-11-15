import crypto from 'crypto';

/*
 * Emailed confirmation codes for the License Management action that a
 * leaked license key + email could otherwise be used for:
 *   'deactivate-all'   /api/deactivate        releases every machine
 * (Air-gapped activation needs no code: /api/activate-airgap emails the
 * response code itself to the address on the license.)
 *
 * Step 1: the endpoint checks the license and email as before, emails a
 *         one-time code to the address on the license, and returns a token.
 * Step 2: the page sends the same inputs again plus the token and the code,
 *         and the endpoint only acts if both check out.
 *
 * No database. A token is  base64url(JSON payload) + "." + HMAC(payload),
 * and the payload holds:
 *   v  format version
 *   a  action
 *   x  expiry, ms since 1970 (10 minutes after the email is sent)
 *   n  random nonce
 *   b  HMAC of (action, license key, email, n), which ties
 *      the token to those inputs without putting them in it
 *   h  HMAC of (n, code); the code itself is only ever in the email
 * Every HMAC is keyed with CONFIRM_CODE_SECRET, so whoever holds a token
 * cannot test guesses offline: each guess is a request, and requests are
 * rate limited. Codes are 8 characters from a 30-character alphabet with no
 * 0/O or 1/I/L, about 6.6 x 10^11 possibilities.
 *
 * Nothing records that a code was used, so a token + code keeps working
 * until it expires. That can only repeat the same action with the same
 * inputs.
 */

export const CONFIRM_TTL_MS = 10 * 60 * 1000;
export const RESEND_AFTER_SECONDS = 60;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const MIN_SECRET_LENGTH = 32;

export const CONFIRM_NOT_SET_UP = 'Email confirmation is not set up on the server yet. Please contact info@cyberrmf.com.';
export const NO_EMAIL_ON_FILE = 'This license has no email on file, so we cannot send a confirmation code. Please contact support at info@cyberrmf.com.';

/* Read at call time, so a missing or short secret always fails closed. */
export function confirmSecretProblem() {
  const secret = process.env.CONFIRM_CODE_SECRET;
  if (!secret) return 'Missing: CONFIRM_CODE_SECRET';
  if (secret.length < MIN_SECRET_LENGTH) return `CONFIRM_CODE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  return null;
}

function mac(...parts) {
  return crypto
    .createHmac('sha256', process.env.CONFIRM_CODE_SECRET)
    .update(JSON.stringify(['cyberrmf-confirm-v1', ...parts]))
    .digest('base64url');
}

function same(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function normalizeLicenseKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function bindInputs(action, key, email, nonce) {
  return mac('bind', action, normalizeLicenseKey(key), String(email || '').trim().toLowerCase(), nonce);
}

/* What the user typed or pasted: with or without the dash, any case, stray spaces. */
export function normalizeConfirmCode(s) {
  return String(s || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function formatConfirmCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/* j•••@example.mil */
export function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${s[0]}•••${s.slice(at)}`;
}

export function newConfirmation({ action, key, email }) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  const n = crypto.randomBytes(16).toString('base64url');
  const payload = {
    v: 1,
    a: action,
    x: Date.now() + CONFIRM_TTL_MS,
    n,
    b: bindInputs(action, key, email, n),
    h: mac('code', n, code),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { code, token: `${body}.${mac('token', body)}` };
}

/* null if the token and code are good for exactly these inputs, otherwise { status, error }. */
export function confirmationProblem({ action, key, email, token, code }) {
  const startAgain = { status: 400, error: 'This confirmation is not valid. Click Back and start again.' };
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !same(parts[1], mac('token', parts[0]))) return startAgain;
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return startAgain;
  }
  if (p?.v !== 1 || p.a !== action) return startAgain;
  if (!(Date.now() < p.x)) {
    return { status: 410, error: 'This code has expired. Click "Send a new code".' };
  }
  if (!same(p.b, bindInputs(action, key, email, p.n))) {
    return { status: 400, error: 'The license key or email changed after we sent the code. Click Back and start again.' };
  }
  const typed = normalizeConfirmCode(code);
  if (typed.length !== CODE_LENGTH || !same(p.h, mac('code', p.n, typed))) {
    return { status: 403, error: 'That code is not correct. Check the newest email from CyberRMF and try again.' };
  }
  return null;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/*
 * Same sender and look as the receipts. `rows` are [label, value] pairs
 * shown under the code. Returns null when sent, otherwise
 * { status, error } for the page.
 */
export async function sendConfirmationEmail({ to, code, what, intro, accent, rows }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('Confirmation email not sent: missing env vars:', ['RESEND_API_KEY']);
    return { status: 500, error: CONFIRM_NOT_SET_UP };
  }
  const shown = formatConfirmCode(code);
  const rowsHtml = rows.map(([label, value]) => `
                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:16px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(label)}</p>
                  <p style="font-size:14px;color:#e5e7eb;margin:0;word-break:break-all;">${escapeHtml(value)}</p>
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
        subject: `CyberRMF confirmation code (${what})`,
        // A new value on every email stops Gmail from threading the codes
        // together and hiding the newest one.
        headers: { 'X-Entity-Ref-ID': crypto.randomUUID() },
        html: `
              <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
                <h2 style="color:${accent};margin:0 0 8px;">Your Confirmation Code</h2>
                <p style="color:#9ca3af;font-size:13px;margin:0 0 20px;">${escapeHtml(intro)}</p>
                <div style="background:#23272e;border:2px solid ${accent};border-radius:6px;padding:16px;margin-bottom:20px;text-align:center;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Confirmation Code</p>
                  <p style="font-size:24px;font-weight:700;color:${accent};margin:0;letter-spacing:0.15em;">${shown}</p>
                  <p style="font-size:11px;color:#6b7280;margin:8px 0 0;">The code works for 10 minutes.</p>
                </div>${rowsHtml}
                <div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:6px;padding:12px 16px;margin-bottom:20px;">
                  <p style="font-size:12px;color:#fde68a;margin:0;">
                    <strong>You did not ask for this?</strong> Do not give this code to anyone. Nothing happens without it.
                    Someone may know your license key, so please tell us at info@cyberrmf.com.
                  </p>
                </div>
                <p style="font-size:12px;color:#6b7280;margin:20px 0 0;text-align:center;">
                  Questions? <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
                </p>
              </div>
            `,
        text: [
          'Your CyberRMF confirmation code',
          '',
          intro,
          '',
          `Confirmation code: ${shown}`,
          'The code works for 10 minutes.',
          '',
          ...rows.map(([label, value]) => `${label}: ${value}`),
          '',
          'You did not ask for this? Do not give this code to anyone. Nothing happens without it.',
          'Someone may know your license key, so please tell us at info@cyberrmf.com.',
        ].join('\n'),
      }),
    });
    if (!emailRes.ok) {
      console.error('Confirmation email failed:', emailRes.status, await emailRes.text().catch(() => ''));
      return { status: 502, error: 'We could not send the email with your code. Please try again in a few minutes, or contact info@cyberrmf.com.' };
    }
    return null;
  } catch (mailErr) {
    console.error('Confirmation email failed:', mailErr);
    return { status: 502, error: 'We could not send the email with your code. Please try again in a few minutes, or contact info@cyberrmf.com.' };
  }
}
