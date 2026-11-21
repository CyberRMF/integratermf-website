/*
 * The two apps. Each has its own licenses under its own Keygen policy, and
 * every license endpoint is told which app the request is for (`product`).
 *
 * The product ids are part of the signed air-gapped response code, so they
 * must match LicenseApp.product in the app's shared/ipc/keygen.ts.
 *
 * Policy IDs are read at call time, so a missing one always fails closed.
 */

export const PRODUCTS = {
  'integrate':   { name: 'CyberRMF Integrate',   policyEnv: 'KEYGEN_POLICY_ID_INTEGRATE' },
  'admin-tools': { name: 'CyberRMF Admin Tools', policyEnv: 'KEYGEN_POLICY_ID_ADMIN_TOOLS' },
};

export function isProduct(product) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, product);
}

export function productName(product) {
  return PRODUCTS[product].name;
}

export function policyIdFor(product) {
  return process.env[PRODUCTS[product].policyEnv] || '';
}

/* The product a Keygen policy belongs to, or null. */
export function productForPolicy(policyId) {
  if (!policyId) return null;
  return Object.keys(PRODUCTS).find(p => policyIdFor(p) === policyId) || null;
}

/* Names of the policy variables that aren't set, for the endpoints' "Missing:" list. */
export function missingPolicyEnv() {
  return Object.values(PRODUCTS).map(p => p.policyEnv).filter(name => !process.env[name]);
}

/* null if `product` names an app, otherwise { status, error }. `inApp`: the caller is the desktop app. */
export function productProblem(product, { inApp = false } = {}) {
  if (isProduct(product)) return null;
  return {
    status: 400,
    error: inApp
      ? 'Update CyberRMF to the latest version and try again, or release this machine at integratermf.com/license.'
      : 'Choose CyberRMF Integrate or CyberRMF Admin Tools at the top of the page.',
  };
}

/*
 * null if the license is under `product`'s policy, otherwise { status, error }
 * naming the app the license is for. `licensePolicyId` is
 * data.relationships.policy.data.id from validate-key.
 */
export function wrongProductProblem(product, licensePolicyId, { inApp = false } = {}) {
  const owner = productForPolicy(licensePolicyId);
  if (owner === product) return null;
  if (!owner) {
    return {
      status: 409,
      error: 'This license key is not for CyberRMF Integrate or CyberRMF Admin Tools. If it came from an earlier purchase, contact info@cyberrmf.com for new keys.',
    };
  }
  const right = productName(owner);
  return {
    status: 409,
    error: inApp
      ? `This license key is for ${right}, not ${productName(product)}. Release it at integratermf.com/license and choose ${right} there.`
      : `This license key is for ${right}. Choose ${right} at the top of the page.`,
  };
}
