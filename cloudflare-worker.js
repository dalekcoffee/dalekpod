// Cloudflare Worker — CORS proxy for Plex API calls from pod.dalek.coffee
// Proxies fetch() requests that browsers would otherwise block due to Plex's
// CORS policy (Access-Control-Allow-Origin: https://app.plex.tv only).
// Only requests from the exact allowed origin are forwarded, and only to
// known Plex hosts. No credentials are logged.

const ALLOWED_ORIGIN  = 'https://pod.dalek.coffee';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'OPTIONS']);
const MAX_BODY_BYTES  = 1024 * 64; // 64 KB — Plex API payloads are tiny

// Headers we explicitly allow in CORS preflights
const CORS_ALLOW_HEADERS = [
  'accept', 'content-type',
  'x-plex-token', 'x-plex-client-identifier',
  'x-plex-product', 'x-plex-version', 'x-plex-platform',
  'x-plex-target-client-identifier',
  'x-proxy-url',
].join(', ');

// Headers stripped from the incoming request before forwarding upstream.
// Removes Cloudflare-injected headers and proxy routing meta-headers so the
// Plex server only sees what the browser originally intended to send.
const STRIPPED_HEADERS = [
  'host', 'origin', 'x-proxy-url',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-ew-via', 'cf-worker', 'true-client-ip',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
];

export default {
  async fetch(request) {
    // ── Origin gate ──────────────────────────────────────────────────────────
    const origin = request.headers.get('Origin');
    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── CORS preflight ───────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Method gate ──────────────────────────────────────────────────────────
    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response('Method not allowed', { status: 405 });
    }

    // ── POST/PUT body size gate ──────────────────────────────────────────────
    // Require Content-Length on mutating requests so we can enforce the limit
    // without buffering the entire body (which would double memory usage).
    if (request.method === 'POST' || request.method === 'PUT') {
      const cl = request.headers.get('Content-Length');
      if (!cl) return new Response('Content-Length required', { status: 411 });
      const clInt = parseInt(cl, 10);
      if (clInt < 0 || isNaN(clInt) || clInt > MAX_BODY_BYTES) {
        return new Response('Payload too large', { status: 413 });
      }
    }

    // ── Target URL validation ────────────────────────────────────────────────
    const targetUrl = request.headers.get('X-Proxy-URL');
    if (!targetUrl) {
      return new Response('Missing X-Proxy-URL header', { status: 400 });
    }

    let parsed;
    try { parsed = new URL(targetUrl); } catch {
      return new Response('Invalid target URL', { status: 400 });
    }

    if (parsed.protocol !== 'https:') {
      return new Response('HTTPS required', { status: 400 });
    }

    const host = parsed.hostname.toLowerCase();
    // Reject bare IPv4/IPv6 addresses — Plex uses domain names only
    if (/^[\d.:[\]]+$/.test(host)) {
      return new Response('IP addresses not allowed', { status: 403 });
    }
    const isAllowedHost = host.endsWith('.plex.direct')
      || host === 'plex.tv'
      || host.endsWith('.plex.tv');
    if (!isAllowedHost) {
      return new Response('Target host not allowed', { status: 403 });
    }

    // ── Build forwarded headers ──────────────────────────────────────────────
    // Start from all incoming headers, then strip proxy/CF meta-headers.
    // The Plex token stays in the x-plex-token header — never put credentials
    // in the URL (they appear in server access logs and CF subrequest logs).
    const proxyHeaders = new Headers(request.headers);
    for (const name of STRIPPED_HEADERS) {
      proxyHeaders.delete(name);
    }

    // ── Upstream request ─────────────────────────────────────────────────────
    try {
      const res = await fetch(targetUrl, {
        method:  request.method,
        headers: proxyHeaders,
        body:    (request.method === 'POST' || request.method === 'PUT') ? request.body : undefined,
      });

      // Stream the response back; rewrite CORS headers so the browser accepts it
      const responseHeaders = new Headers(res.headers);
      responseHeaders.delete('Access-Control-Allow-Origin');
      responseHeaders.delete('Access-Control-Allow-Credentials');
      responseHeaders.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

      return new Response(res.body, {
        status:     res.status,
        statusText: res.statusText,
        headers:    responseHeaders,
      });
    } catch {
      return new Response('Bad gateway', { status: 502 });
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age':       '86400',
  };
}
