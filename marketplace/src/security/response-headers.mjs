/** Response-only protections: no markup, wallet permissions or styling changes. */
export function protectResponse(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  if (pathname === '/app' || pathname.startsWith('/app/') || pathname === '/technical' || pathname.startsWith('/technical/') || pathname.startsWith('/api/')) {
    headers.set('X-Frame-Options', 'DENY');
    // Multiple policies are jointly enforced; never replace a stricter policy.
    headers.append('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  }
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}
