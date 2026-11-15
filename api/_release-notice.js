import crypto from 'crypto';
import { escapeHtml } from './_confirm.js';
import { productName } from './_products.js';

/*
 * The email sent to the address on a license whenever machines are released
 * from it, by any route: release all (/api/deactivate), Air-Gapped
 * Deactivation (/api/deactivate-airgap) and Deactivate This Machine in the
 * app (/api/deactivate-this-machine).
 *
 * `to` must be the address stored on the license, never a typed one. Only
 * the last 4 characters of the key are shown.
 *
 * Best-effort: a failed send is logged and never undoes or fails the release.
 */
export async function sendReleaseNotice({ to, product, key, released, machineName, how }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('Release notice not sent (non-fatal): Missing RESEND_API_KEY');
    return;
  }
  const app = productName(product);
  const keyEnd = String(key || '').slice(-4);
  const when = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  const summary = released === 1
    ? `A machine was released from your ${app} license.`
    : `${released} machines were released from your ${app} license.`;
  const rows = [
    ['App', app],
    ['License key ending in', keyEnd],
    released === 1 && machineName ? ['Machine', machineName] : ['Machines released', String(released)],
    ['Date', when],
    ['How', how],
  ];
  const rowsHtml = rows.map(([label, value]) => `
                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:12px 16px;margin-bottom:12px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(label)}</p>
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
        subject: `${app}: ${released === 1 ? 'a machine was' : `${released} machines were`} released from your license`,
        headers: { 'X-Entity-Ref-ID': crypto.randomUUID() },
        html: `
              <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
                <h2 style="color:#60a5fa;margin:0 0 8px;">${released === 1 ? 'Machine Released' : 'Machines Released'}</h2>
                <p style="color:#9ca3af;font-size:13px;margin:0 0 20px;">${escapeHtml(summary)} The license key can now be activated on another machine.</p>${rowsHtml}
                <div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:6px;padding:12px 16px;margin:8px 0 20px;">
                  <p style="font-size:12px;color:#fde68a;margin:0;">
                    <strong>If you didn't do this, contact info@cyberrmf.com.</strong>
                  </p>
                </div>
                <p style="font-size:12px;color:#6b7280;margin:20px 0 0;text-align:center;">
                  Questions? <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
                </p>
              </div>
            `,
        text: [
          summary,
          'The license key can now be activated on another machine.',
          '',
          ...rows.map(([label, value]) => `${label}: ${value}`),
          '',
          "If you didn't do this, contact info@cyberrmf.com.",
        ].join('\n'),
      }),
    });
    if (!emailRes.ok) {
      console.error('Release notice failed (non-fatal):', emailRes.status, await emailRes.text().catch(() => ''));
    }
  } catch (mailErr) {
    console.error('Release notice failed (non-fatal):', mailErr);
  }
}
