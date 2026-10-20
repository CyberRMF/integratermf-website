// /api/unsubscribe
//
// Handles:
//   GET  /api/unsubscribe?e=<email>&t=<hmac>   -> browser click, shows HTML page
//   POST /api/unsubscribe?e=<email>&t=<hmac>   -> RFC 8058 one-click (Gmail/Yahoo native unsubscribe)
//
// Both verify an HMAC-SHA256 token of the email (prevents attackers unsubscribing
// arbitrary users) and PATCH the Resend contact to unsubscribed=true. Resend's
// Broadcasts API will then automatically skip that contact on future sends.

import crypto from 'crypto';

const RESEND_API_KEY     = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET;

function verifyToken(email, token) {
  if (!email || !token || !UNSUBSCRIBE_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET)
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 24);
  if (expected.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch (_) {
    return false;
  }
}

async function markResendContactUnsubscribed(email) {
  if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID) {
    return { ok: false, reason: 'audience_not_configured' };
  }
  try {
    const url = `https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email.toLowerCase())}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ unsubscribed: true }),
    });
    if (r.ok) return { ok: true };
    // 404 just means the contact was never added to the audience — treat as
    // success from the user's perspective (they're already not getting broadcasts).
    const body = await r.text();
    if (r.status === 404) {
      console.warn('Unsubscribe: contact not in audience, OK:', email);
      return { ok: true, reason: 'not_in_audience' };
    }
    console.error('Resend PATCH failed:', r.status, body);
    return { ok: false, reason: 'resend_error', status: r.status };
  } catch (err) {
    console.error('Unsubscribe network error:', err);
    return { ok: false, reason: 'network_error' };
  }
}

function renderPage({ ok, email }) {
  const headline = ok ? "You're unsubscribed" : 'Request received';
  const message = ok
    ? `We've removed <strong>${email || 'your email address'}</strong> from CyberRMF marketing and announcement lists. You will still receive transactional messages (such as license-activation or deactivation confirmations) related to any license you already requested.`
    : `We've logged your unsubscribe request${email ? ` for <strong>${email}</strong>` : ''} and will complete it manually within one business day. If you don't hear back, please email <a href="mailto:info@cyberrmf.com" style="color:#3b82f6;">info@cyberrmf.com</a>.`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>${headline} &mdash; CyberRMF</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: 'Consolas', 'Courier New', monospace;
    background: #111111; color: #e4e6eb; line-height: 1.7;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; min-height: 100vh;
  }
  .card {
    max-width: 540px; width: 100%; background: #1a1d23;
    border: 1px solid #3a3f4b; border-radius: 10px; padding: 36px 32px;
    text-align: center;
  }
  .eyebrow {
    font-size: 11px; color: #3b82f6; text-transform: uppercase;
    letter-spacing: 0.08em; margin-bottom: 10px;
  }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 16px; color: #e4e6eb; }
  p { font-size: 13px; color: #9ca3af; margin-bottom: 12px; }
  p strong { color: #e4e6eb; font-weight: 600; }
  .footer-links {
    margin-top: 24px; padding-top: 20px; border-top: 1px solid #3a3f4b;
    font-size: 11px; color: #6b7280;
  }
  .footer-links a { color: #8b8b8b; text-decoration: underline; margin: 0 6px; }
  .footer-links a:hover { color: #e4e6eb; }
</style>
</head><body>
  <div class="card">
    <div class="eyebrow">CyberRMF</div>
    <h1>${headline}</h1>
    <p>${message}</p>
    <div class="footer-links">
      <a href="https://integratermf.com/privacy.html">Privacy</a> &middot;
      <a href="https://integratermf.com/do-not-sell.html">Do Not Sell or Share</a> &middot;
      <a href="https://integratermf.com/security.html">Security</a>
    </div>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).send('Method not allowed');
  }

  const email = (req.query?.e || '').toString().trim().toLowerCase();
  const token = (req.query?.t || '').toString().trim();

  // RFC 8058 one-click POST: respond 200 OK fast, process in the background.
  // Must not require any further interaction from the user.
  if (req.method === 'POST') {
    res.status(200).send('OK');
    if (email && verifyToken(email, token)) {
      const r = await markResendContactUnsubscribed(email);
      console.log('One-click unsubscribe:', email, r);
    } else {
      console.warn('One-click unsubscribe rejected (bad or missing token):', email || '(none)');
    }
    return;
  }

  // Browser GET: process synchronously, render HTML page.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!email || !verifyToken(email, token)) {
    console.warn('GET unsubscribe rejected (bad or missing token):', email || '(none)');
    return res.status(400).send(renderPage({ ok: false, email: '' }));
  }

  const result = await markResendContactUnsubscribed(email);
  console.log('GET unsubscribe:', email, result);
  return res.status(200).send(renderPage({ ok: result.ok, email }));
}
