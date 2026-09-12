/**
 * Route patterns whose path parameter is itself a bearer credential (a
 * guest order tracking token, today) - if it appears verbatim in a server
 * log line, anyone with read access to logs could use it to track (and,
 * for a tracking token, read the address/phone/items of) that guest's
 * order, without ever needing to compromise the guest. `request.url`/
 * `request.originalUrl` must never be logged raw for these routes.
 *
 * Add a new entry here whenever a new route puts a bearer-style token in
 * its path (never in a query string) - this list is deliberately explicit
 * rather than a generic "long random-looking segment" heuristic, so it
 * never accidentally redacts a plain resource id (order id, product id)
 * that's genuinely useful for debugging.
 */
const SENSITIVE_URL_PATTERNS: RegExp[] = [
  // GET /api/v1/orders/track/:trackingToken
  /(\/orders\/track\/)[^/?]+/gi,
];

/**
 * Replaces any sensitive credential segment in a request URL with
 * `[REDACTED]` before it is written to a log. Safe to call on every
 * request - a URL that matches nothing is returned unchanged.
 */
export function redactSensitiveUrl(url: string): string {
  let redacted = url;
  for (const pattern of SENSITIVE_URL_PATTERNS) {
    redacted = redacted.replace(pattern, '$1[REDACTED]');
  }
  return redacted;
}
