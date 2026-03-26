// Cloudflare Worker — CORS proxy for Plex API calls from pod.dalek.coffee
// Deploy at: plex-proxy.dalek.coffee (or any subdomain you prefer)
//
// SETUP:
// 1. Go to dash.cloudflare.com → Workers & Pages → Create
// 2. Name it "plex-proxy" → Deploy
// 3. Edit Code → paste this file → Save and Deploy
// 4. Go to Settings → Triggers → Custom Domains → add "plex-proxy.dalek.coffee"
//    (or use the *.workers.dev URL and update PROXY_ORIGIN in mediapod.js)

const ALLOWED_ORIGIN = 'https://pod.dalek.coffee';

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

    // The real Plex URL is passed in the X-Proxy-URL header
    const targetUrl = request.headers.get('X-Proxy-URL');
    if (!targetUrl) {
      return new Response('Missing X-Proxy-URL header', { status: 400 });
    }

    // Validate target is a Plex domain (prevent open relay abuse)
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return new Response('Invalid URL', { status: 400 }); }
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = host.endsWith('.plex.direct') || host === 'plex.tv' || host.endsWith('.plex.tv');
    if (!allowedHosts) {
      return new Response('Target host not allowed', { status: 403 });
    }

    // Forward the request to Plex, stripping proxy-specific headers
    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.delete('X-Proxy-URL');
    proxyHeaders.delete('Origin');
    proxyHeaders.delete('Host');

    try {
      const res = await fetch(targetUrl, {
        method: request.method,
        headers: proxyHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      });

      // Return response with CORS headers added
      const responseHeaders = new Headers(res.headers);
      responseHeaders.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');
      responseHeaders.delete('Access-Control-Allow-Origin'); // remove Plex's header first
      responseHeaders.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });
    } catch (e) {
      return new Response(`Proxy error: ${e.message}`, { status: 502 });
    }
  },
};

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
    'Access-Control-Max-Age': '86400',
  };
}
