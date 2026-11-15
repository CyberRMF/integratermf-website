import { clientIp, takeToken, tooManyRequests } from './_rate-limit.js';
import {
  CONFIRM_NOT_SET_UP, NO_EMAIL_ON_FILE, RESEND_AFTER_SECONDS, CONFIRM_TTL_MS,
  confirmSecretProblem, newConfirmation, confirmationProblem, sendConfirmationEmail, maskEmail,
} from './_confirm.js';
import { missingPolicyEnv, productName, productProblem, wrongProductProblem } from './_products.js';
import { sendReleaseNotice } from './_release-notice.js';

/*
 * Online license deactivation.
 *
 * Flow:
 *   1. User visits integratermf.com/deactivate (Online tab), chooses the
 *      app, enters { product, key, email }, hits Send Code to My Email.
 *   2. This endpoint:
 *        a. Validates the license against Keygen (finds the license id)
 *           and checks it is under the chosen app's policy.
 *        b. Verifies that the license's stored `metadata.email` matches
 *           the caller's email (403 otherwise). A license with no email
 *           on file is refused (409): there is nowhere to send a code.
 *        c. Emails a one-time confirmation code to that address and
 *           returns { confirmationRequired, confirmToken, sentTo }.
 *           See _confirm.js. Nothing is released yet.
 *   3. The page posts { product, key, email, confirmToken, confirmCode }.
 *      This endpoint checks the token and code, repeats a and b, then:
 *        d. Lists every machine currently attached to the license.
 *        e. Deletes each machine record via the Keygen admin token.
 *        f. Best-effort release notice to the address on the license.
 *
 *   Knowing a leaked key + email is no longer enough: the code goes to
 *   the license owner's mailbox.
 *
 *   Result: the license slot count is now 0/N and the customer can
 *   reactivate on a fresh machine.
 *
 * Required env vars:
 *   KEYGEN_ACCOUNT_ID
 *   KEYGEN_ADMIN_TOKEN     (needs machine.read + machine.delete permissions)
 *   KEYGEN_POLICY_ID_INTEGRATE, KEYGEN_POLICY_ID_ADMIN_TOOLS
 *   RESEND_API_KEY         (sends the confirmation code and the release notice)
 *   CONFIRM_CODE_SECRET    (signs the confirmation token, >= 32 chars)
 */

const KEYGEN_ACCOUNT_ID  = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;

const ACTION = 'deactivate-all';
const TEN_MINUTES = 10 * 60 * 1000;

function normalizeLicenseKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wait = takeToken('deactivate', clientIp(req), 10, TEN_MINUTES);
  if (wait) return tooManyRequests(res, wait);

  const missing = [];
  if (!KEYGEN_ACCOUNT_ID)  missing.push('KEYGEN_ACCOUNT_ID');
  if (!KEYGEN_ADMIN_TOKEN) missing.push('KEYGEN_ADMIN_TOKEN');
  missing.push(...missingPolicyEnv());
  if (missing.length) {
    console.error('deactivate: missing env vars:', missing);
    return res.status(500).json({ error: 'Server configuration error' });
  }
  const secretProblem = confirmSecretProblem();
  if (secretProblem) {
    console.error('deactivate: confirmation codes disabled:', secretProblem);
    return res.status(500).json({ error: CONFIRM_NOT_SET_UP });
  }

  const { product, key, email, confirmToken, confirmCode } = req.body || {};
  const badProduct = productProblem(product);
  if (badProduct) return res.status(badProduct.status).json({ error: badProduct.error });
  if (!key || !email) {
    return res.status(400).json({ error: 'License key and email are required.' });
  }

  const normalizedKey = normalizeLicenseKey(key);
  const confirming = Boolean(confirmToken || confirmCode);

  if (confirming) {
    if (!confirmToken || !confirmCode) {
      return res.status(400).json({ error: 'Enter the code from the email.' });
    }
    const problem = confirmationProblem({ action: ACTION, key: normalizedKey, email, token: confirmToken, code: confirmCode });
    if (problem) return res.status(problem.status).json({ error: problem.error });
  }

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
    const licensePolicy = validateJson?.data?.relationships?.policy?.data?.id;

    if (!licenseId) {
      return res.status(404).json({ error: 'License key not found. Double-check for typos.' });
    }
    const wrongProduct = wrongProductProblem(product, licensePolicy);
    if (wrongProduct) {
      return res.status(wrongProduct.status).json({ error: wrongProduct.error });
    }
    if (!licenseEmail) {
      return res.status(409).json({ error: NO_EMAIL_ON_FILE });
    }
    if (String(licenseEmail).trim().toLowerCase() !== String(email).trim().toLowerCase()) {
      return res.status(403).json({ error: 'Email does not match the address the license was issued to.' });
    }

    /* ── 1b. First request: email a confirmation code and stop here ── */
    if (!confirming) {
      const sendWait = takeToken('confirm-email', normalizedKey, 5, TEN_MINUTES);
      if (sendWait) return tooManyRequests(res, sendWait);

      const { code, token } = newConfirmation({ action: ACTION, key: normalizedKey, email });
      const sendProblem = await sendConfirmationEmail({
        to: licenseEmail,
        code,
        what: 'release all machines',
        intro: `Someone asked on integratermf.com to release every machine on your ${productName(product)} license. To do it, enter this code on that page.`,
        accent: '#60a5fa',
        rows: [['License Key', normalizedKey]],
      });
      if (sendProblem) {
        return res.status(sendProblem.status).json({ error: sendProblem.error });
      }
      const sentTo = maskEmail(licenseEmail);
      return res.status(200).json({
        confirmationRequired: true,
        confirmToken: token,
        sentTo,
        expiresInSeconds: CONFIRM_TTL_MS / 1000,
        resendAfterSeconds: RESEND_AFTER_SECONDS,
        message: `We emailed a code to ${sentTo}. Enter it on this page to release all machines.`,
      });
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

    /* ── 4. Best-effort release notice ── */
    const onlyOne = removed === 1 ? results.find(r => r.ok) : null;
    await sendReleaseNotice({
      to: licenseEmail,
      product,
      key: normalizedKey,
      released: removed,
      machineName: onlyOne?.name,
      how: 'Release all machines, on integratermf.com',
    });

    return res.status(200).json({
      success: true,
      machinesRemoved: removed,
      message: `${removed} machine slot${removed === 1 ? '' : 's'} released. You can now activate on a new machine using ${normalizedKey}.`,
    });

  } catch (err) {
    console.error('deactivate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
