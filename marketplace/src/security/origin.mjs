export const DEFAULT_SONA_ORIGIN = 'https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site';

function bareOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    // Reject wildcard hosts and parser-normalized aliases rather than silently
    // changing the origin that an operator intended to authorize.
    if (url.origin !== value || url.hostname.length > 253
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Only explicitly configured origins can receive origin-bound wallet auth. */
export function resolveSonaOrigin(requestOrigin, configuredOrigin, aliasOrigin) {
  const configured = configuredOrigin === undefined ? undefined : bareOrigin(configuredOrigin);
  const alias = aliasOrigin === undefined ? undefined : bareOrigin(aliasOrigin);
  // A malformed deployment setting must not fall back to another origin.
  if (configured === null || alias === null) return null;
  if (alias !== undefined) {
    if (configured === undefined) return null;
    const canonical = new URL(configured);
    // The optional alias is only the explicitly configured www host, never an
    // arbitrary extra origin or an automatically trusted subdomain.
    if (canonical.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(canonical.hostname)
      || canonical.hostname.startsWith('www.') || alias !== `https://www.${canonical.host}`) return null;
  }
  const requested = bareOrigin(requestOrigin);
  if (requested !== null && [DEFAULT_SONA_ORIGIN, configured, alias].includes(requested)) return requested;
  return null;
}
