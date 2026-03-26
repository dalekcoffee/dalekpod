// Cloudflare Worker — CORS proxy for Plex API calls from pod.dalek.coffee
// Deploy at: plex-proxy.dalek.coffee (or any subdomain you prefer)
//
// SETUP:
// 1. Go to dash.cloudflare.com → Workers & Pages → Create
// 2. Name it "plex-proxy" → Deploy
// 3. Edit Code → paste this file → Save and Deploy
// 4. Go to Settings → Triggers → Custom Domains → add "plex-proxy.dalek.coffee"
//    (or use the *.workers.dev URL and update PROXY_ORIGIN in mediapod.js)
//
// RATE LIMITING (optional but recommended):
// The Origin header check stops browser-based abuse but not curl/scripts.
// To add rate limiting: Workers & Pages → your worker → Settings →
// scroll to "Rate Limiting" or use Cloudflare WAF rules on the custom domain.

const ALLOWED_ORIGIN = 'https://pod.dalek.coffee';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS']);
const MAX_BODY_BYTES = 1024 * 64; // 64 KB — Plex API POST bodies are tiny

// Headers to STRIP before forwarding to Plex. This prevents leaking
// Cloudflare-injected metadata while preserving all Plex headers the
// server may need for token validation.
const STRIPPED_HEADERS = [
  'host', 'origin', 'x-proxy-url',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-ew-via', 'cf-worker', 'true-client-ip',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
];

export default {
  async fetch(request) {
    // Only allow requests from our app
    const origin = request.headers.get('Origin');
    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // Restrict HTTP methods to what Plex API actually needs
    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response('Method not allowed', { status: 405 });
    }

    // Reject oversized request bodies (Plex API POSTs are tiny)
    if (request.method === 'POST') {
      const cl = request.headers.get('Content-Length');
      if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
        return new Response('Payload too large', { status: 413 });
      }
    }

    // The real Plex URL is passed in the X-Proxy-URL header
    const targetUrl = request.headers.get('X-Proxy-URL');
    if (!targetUrl) {
      return new Response('Missing X-Proxy-URL header', { status: 400 });
    }

    // Validate target is a Plex domain over HTTPS (prevent open relay / SSRF)
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return new Response('Invalid URL', { status: 400 }); }

    if (parsed.protocol !== 'https:') {
      return new Response('HTTPS required', { status: 400 });
    }

    const host = parsed.hostname.toLowerCase();
    const isAllowedHost = host.endsWith('.plex.direct')
      || host === 'plex.tv'
      || host.endsWith('.plex.tv');
    if (!isAllowedHost) {
      return new Response('Target host not allowed', { status: 403 });
    }

    // Forward all headers except Cloudflare metadata and proxy internals.
    // Plex servers may require headers beyond the documented X-Plex-* set
    // for token validation — stripping too aggressively causes 401s.
    const proxyHeaders = new Headers(request.headers);
    for (const name of STRIPPED_HEADERS) {
      proxyHeaders.delete(name);
    }

    try {
      const res = await fetch(targetUrl, {
        method: request.method,
        headers: proxyHeaders,
        body: request.method === 'POST' ? request.body : undefined,
      });

      // Replace Plex's CORS header with ours
      const responseHeaders = new Headers(res.headers);
      responseHeaders.delete('Access-Control-Allow-Origin');
      responseHeaders.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });
    } catch (_) {
      // Don't leak internal network details in error messages
      return new Response('Bad gateway', { status: 502 });
    }
  },
};

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
    'Access-Control-Max-Age': '86400',
  };
}
