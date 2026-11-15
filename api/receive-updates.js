import { clientIp, takeToken, tooManyRequests } from './_rate-limit.js';

/*
 * The home page's "Receive Updates" box. Emails the address to
 * info@cyberrmf.com; nothing is stored here.
 *
 * Env: RESEND_API_KEY
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TEN_MINUTES = 10 * 60 * 1000;
const EMAIL = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wait = takeToken('receive-updates', clientIp(req), 5, TEN_MINUTES);
  if (wait) return tooManyRequests(res, wait);

  if (!RESEND_API_KEY) {
    console.error('receive-updates: missing env vars:', ['RESEND_API_KEY']);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { email, hp } = req.body || {};
  // hp is a field people never see; only bots fill it in.
  if (hp) return res.status(200).json({ ok: true });

  const address = typeof email === 'string' ? email.trim() : '';
  if (address.length > 254 || !EMAIL.test(address)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const failed = "We couldn't sign you up just now. Please try again, or email info@cyberrmf.com.";
  try {
    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'CyberRMF <no-reply@integratermf.com>',
        to: ['info@cyberrmf.com'],
        reply_to: address,
        subject: `Receive Updates: ${address}`,
        text: `${address} asked to receive updates, using the box on the integratermf.com home page (${new Date().toISOString()}).`,
      }),
    });
    if (!sent.ok) {
      console.error('receive-updates: email to info@ failed:', sent.status, await sent.text().catch(() => ''));
      return res.status(502).json({ error: failed });
    }
  } catch (err) {
    console.error('receive-updates: email to info@ failed:', err);
    return res.status(502).json({ error: failed });
  }

  return res.status(200).json({ ok: true });
}
