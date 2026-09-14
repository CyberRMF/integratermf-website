/*
 * Single-machine online deactivation.
 *
 * Called by the CyberRMF app itself (Deactivate tab → "Deactivate This
 * Machine" button). Unlike /api/deactivate, which releases every machine
 * currently attached to the license, this endpoint releases ONLY the
 * one machine identified by the supplied fingerprint.
 *
 * Flow:
 *   1. Validate the license key against Keygen (find license id).
 *   2. Verify the caller's email matches the license's stored
 *      metadata.email (403 otherwise).
 *   3. List all machines attached to the license and locate the one
 *      whose attributes.fingerprint === the supplied fingerprint.
 *   4. Delete just that one machine record.
 *   5. Best-effort receipt email.
 *
 * Body: { key, email, fingerprint }
 *
 * Required env vars:
 *   KEYGEN_ACCOUNT_ID
 *   KEYGEN_ADMIN_TOKEN     (needs machine.read + machine.delete)
 *   RESEND_API_KEY         (optional)
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

  const { key, email, fingerprint } = req.body || {};
  if (!key || !email || !fingerprint) {
    return res.status(400).json({ error: 'License key, email, and fingerprint are required.' });
  }

  const normalizedKey = normalizeLicenseKey(key);
  const targetFingerprint = String(fingerprint).trim();

  try {
    /* ── 1. Find license id ── */
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

    /* ── 2. List machines under this license ── */
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

    /* ── 3. Find the specific machine by fingerprint ── */
    const match = machines.find(m => m?.attributes?.fingerprint === targetFingerprint);
    if (!match) {
      // Idempotent: already deactivated (or was never registered under this
      // fingerprint). Treat as success so the app can safely clear its
      // local file — no reason to make the user retry.
      return res.status(200).json({
        success: true,
        machinesRemoved: 0,
        message: 'This machine is not currently registered to the license. Nothing to release.',
      });
    }

    /* ── 4. Delete just that one machine ── */
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
      const errBody = await delRes.json().catch(() => ({}));
      const detail = errBody?.errors?.[0]?.detail || 'Failed to delete machine record';
      console.error('Keygen delete-machine error:', delRes.status, errBody);
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
            subject: 'CyberRMF Machine Deactivated',
            html: `
              <div style="font-family:'Consolas','Courier New',monospace;background:#1a1d23;color:#e4e6eb;padding:32px;border-radius:8px;max-width:600px;margin:0 auto;">
                <h2 style="color:#60a5fa;margin:0 0 8px;">Machine Deactivated</h2>
                <p style="color:#9ca3af;font-size:13px;margin:0 0 20px;">
                  One machine slot has been released. Your other machines (if any) remain activated.
                </p>
                <div style="background:#23272e;border:1px solid #3a3f4b;border-radius:6px;padding:16px;margin-bottom:16px;">
                  <p style="font-size:11px;color:#9ca3af;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">License Key</p>
                  <p style="font-size:14px;font-weight:700;color:#60a5fa;margin:0;word-break:break-all;">${normalizedKey}</p>
                </div>
                <p style="font-size:12px;color:#9ca3af;margin:0;">
                  Machine name: <strong>${match.attributes?.name || 'unknown'}</strong>
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
      machinesRemoved: 1,
      machineName: match.attributes?.name,
      message: 'This machine has been released. You can now activate on a different machine using the same license key.',
    });

  } catch (err) {
    console.error('deactivate-this-machine error:', err);
    return res.status(500).json({ error: 'Internal server error', debug: err?.message });
  }
}
