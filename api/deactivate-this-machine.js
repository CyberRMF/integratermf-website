/*
 * Single-machine online deactivation.
 *
 * Called by the CyberRMF app itself (Deactivate tab → "Deactivate This
 * Machine" button). Unlike /api/deactivate, which releases every machine
 * currently attached to the license, this endpoint releases ONLY the
 * one machine identified by the supplied fingerprint.
 *
 * Flow:
 *   1. Validate the license key against Keygen (find license id) and
 *      check it is under the policy of the app that called (`product`).
 *   2. Verify the caller's email matches the license's stored
 *      metadata.email (403 otherwise).
 *   3. List all machines attached to the license and locate the one
 *      whose attributes.fingerprint === the supplied fingerprint.
 *   4. Delete just that one machine record.
 *   5. Best-effort release notice to the address on the license.
 *
 * Body: { product, key, email, fingerprint }
 *
 * Required env vars:
 *   KEYGEN_ACCOUNT_ID
 *   KEYGEN_ADMIN_TOKEN     (needs machine.read + machine.delete)
 *   KEYGEN_POLICY_ID_INTEGRATE, KEYGEN_POLICY_ID_ADMIN_TOOLS
 *   RESEND_API_KEY         (sends the release notice; without it the release still happens)
 *
 * The request and response shapes are used by the desktop app
 * (shared/ipc/keygen.ts, license-deactivate-online). Don't change them.
 * The app shows `error`, and treats a `machinesRemoved` field as success.
 */

import { clientIp, takeToken, tooManyRequests } from './_rate-limit.js';
import { missingPolicyEnv, productName, productProblem, wrongProductProblem } from './_products.js';
import { sendReleaseNotice } from './_release-notice.js';

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;

function normalizeLicenseKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Generous: many PCs behind one office NAT share an IP.
  const wait = takeToken('deactivate-this-machine', clientIp(req), 60, 10 * 60 * 1000);
  if (wait) return tooManyRequests(res, wait);

  const missing = [];
  if (!KEYGEN_ACCOUNT_ID)  missing.push('KEYGEN_ACCOUNT_ID');
  if (!KEYGEN_ADMIN_TOKEN) missing.push('KEYGEN_ADMIN_TOKEN');
  missing.push(...missingPolicyEnv());
  if (missing.length) {
    console.error('deactivate-this-machine: missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { product, key, email, fingerprint } = req.body || {};
  const badProduct = productProblem(product, { inApp: true });
  if (badProduct) return res.status(badProduct.status).json({ error: badProduct.error });
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
    const licensePolicy = validateJson?.data?.relationships?.policy?.data?.id;

    if (!licenseId) {
      return res.status(404).json({ error: 'License key not found. Double-check for typos.' });
    }
    const wrongProduct = wrongProductProblem(product, licensePolicy, { inApp: true });
    if (wrongProduct) {
      return res.status(wrongProduct.status).json({ error: wrongProduct.error });
    }
    // Fail CLOSED if the license has no email on file — otherwise the
    // check below is skipped and any caller could deactivate a machine
    // just by knowing the key. If you hit this, add the email to the
    // license's metadata in the Keygen dashboard and try again.
    if (!licenseEmail) {
      return res.status(409).json({
        error: 'This license has no email on file, so single-machine deactivation cannot verify ownership. Please contact support at info@cyberrmf.com.',
      });
    }
    if (String(licenseEmail).trim().toLowerCase() !== String(email).trim().toLowerCase()) {
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

    /* ── 5. Best-effort release notice ── */
    await sendReleaseNotice({
      to: licenseEmail,
      product,
      key: normalizedKey,
      released: 1,
      machineName: match.attributes?.name || match.id,
      how: `Deactivate This Machine, in ${productName(product)}`,
    });

    return res.status(200).json({
      success: true,
      machinesRemoved: 1,
      machineName: match.attributes?.name,
      message: 'This machine has been released. You can now activate on a different machine using the same license key.',
    });

  } catch (err) {
    console.error('deactivate-this-machine error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
