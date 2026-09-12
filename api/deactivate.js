/*
 * Online license deactivation.
 *
 * Flow:
 *   1. User visits integratermf.com/deactivate (Online tab), enters
 *      { licenseKey, email }, hits Deactivate.
 *   2. This endpoint:
 *        a. Validates the license against Keygen (finds the license id).
 *        b. Verifies that the license's stored `metadata.email` matches
 *           the caller's email (403 otherwise) — so a random person who
 *           only knows a leaked key can't release someone else's slots.
 *        c. Lists every machine currently attached to the license.
 *        d. Deletes each machine record via the Keygen admin token.
 *        e. Best-effort Resend receipt.
 *
 *   Result: the license slot count is now 0/N and the customer can
 *   reactivate on a fresh machine.
 *
 * Required env vars:
 *   KEYGEN_ACCOUNT_ID
 *   KEYGEN_ADMIN_TOKEN     (needs machine.read + machine.delete permissions)
 *   RESEND_API_KEY         (optional; skipped silently if unset)
 */

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;

function normalizeLicenseKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
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

  const { key, email } = req.body || {};
  if (!key || !email) {
    return res.status(400).json({ error: 'License key and email are required.' });
  }

  const normalizedKey = normalizeLicenseKey(key);

  try {
    /* ── 1. Find the license id by validating the key ── */
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

    /* ── 2. List every machine currently attached to this license ── */
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

    /* ── 3. Delete every machine ── */
    const results = await Promise.all(machines.map(async m => {
      const delRes = await fetch(
        `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/machines/${m.id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${KEYGEN_ADMIN_TOKEN}`,
            Accept: 'application/vnd.api+json',
          },
        }
      );
      return { id: m.id, name: m.attributes?.name, ok: delRes.status === 204 || delRes.ok };
    }));

    const removed = results.filter(r => r.ok).length;
    const failed  = results.filter(r => !r.ok);
    if (failed.length && removed === 0) {
      return res.status(502).json({ error: `Failed to release ${failed.length} machine(s). Please try again or contact support.` });
    }

    /* ── 4. Best-effort receipt ── */
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
            subject: 'CyberRMF License Deactivation Confirmation',
            html: `
              <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
                <h2 style="color:#60a5fa;margin:0 0 8px;">License Deactivated</h2>
                <p style="color:#9ca3af;font-size:13px;margin:0 0 20px;">
                  Your license slot has been released. You can now activate CyberRMF on a new machine using the same license key.
                </p>
                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:16px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">License Key</p>
                  <p style="font-size:14px;font-weight:700;color:#60a5fa;margin:0;word-break:break-all;">${normalizedKey}</p>
                </div>
                <p style="font-size:12px;color:#9ca3af;margin:0;">
                  <strong>${removed}</strong> machine slot${removed === 1 ? '' : 's'} released.
                </p>
                <p style="font-size:12px;color:#6b7280;margin:20px 0 0;text-align:center;">
                  Questions? <a href="mailto:info@cyberrmf.com" style="color:#60a5fa;">info@cyberrmf.com</a>
                </p>
              </div>
            `,
          }),
        });
      } catch (mailErr) {
        console.error('Deactivation receipt failed (non-fatal):', mailErr);
      }
    }

    return res.status(200).json({
      success: true,
      machinesRemoved: removed,
      message: `${removed} machine slot${removed === 1 ? '' : 's'} released. You can now activate on a new machine using ${normalizedKey}.`,
    });

  } catch (err) {
    console.error('deactivate error:', err);
    return res.status(500).json({ error: 'Internal server error', debug: err?.message });
  }
}
