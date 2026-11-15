/*
 * Request limits for the license endpoints.
 *
 * Files in api/ whose names start with "_" are not deployed as functions,
 * so this is only importable by the endpoints.
 *
 * Counts live in the memory of one function instance. Vercel runs several
 * instances (more under load, separate ones per region) and starts fresh
 * ones after idle periods, so a client that lands on different instances
 * can get more than `limit` requests through. Treat this as a speed bump.
 * The real limit is the Vercel Firewall rate-limit rule configured in the
 * dashboard, which counts at the edge before any function runs.
 */

const buckets = new Map();
const MAX_ENTRIES = 5000;

/* Vercel sets x-real-ip and overwrites x-forwarded-for, so clients can't spoof them. */
export function clientIp(req) {
  const h = req.headers || {};
  if (h['x-real-ip']) return String(h['x-real-ip']).trim();
  if (h['x-forwarded-for']) return String(h['x-forwarded-for']).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/*
 * Fixed window, like the Vercel Firewall rule. Counts one request for `id`
 * in `bucket`. Returns 0 if it may go ahead, otherwise the number of
 * seconds until the window resets.
 */
export function takeToken(bucket, id, limit, windowMs) {
  const now = Date.now();
  const k = `${bucket}|${id}`;
  let entry = buckets.get(k);
  if (!entry || entry.resetAt <= now) {
    if (buckets.size >= MAX_ENTRIES) prune(now);
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(k, entry);
  }
  entry.count += 1;
  if (entry.count <= limit) return 0;
  return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

function prune(now) {
  for (const [k, e] of buckets) {
    if (e.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size >= MAX_ENTRIES) buckets.clear();
}

/* 429 with only an `error` field: the desktop app shows `error` and treats a `machinesRemoved` field as success. */
export function tooManyRequests(res, retryAfterSeconds) {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    error: `Too many attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`,
  });
}
