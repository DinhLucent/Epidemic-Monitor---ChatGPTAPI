/**
 * Cloudflare Pages global middleware.
 * - Same-origin restriction: only our own web UI can call /api/*
 * - Handles OPTIONS preflight
 *
 * Note: For production-grade rate limiting, configure Cloudflare Rate Limiting Rules
 * in the dashboard.
 */

// Whitelist of allowed origins for /api/* endpoints
const ALLOWED_ORIGINS = [
  'http://localhost:5173',  // Vite dev
  'http://localhost:5174',  // Docker/wrangler mapped port
  'http://127.0.0.1:5174',
  'http://localhost:8788',  // wrangler pages dev
];

/** Dynamic CORS headers based on request origin. */
function buildCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const selfOrigin = new URL(request.url).origin;
  const allowed = origin && (origin === selfOrigin || ALLOWED_ORIGINS.includes(origin))
    ? origin
    : selfOrigin;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

/** Check if request originates from an allowed web origin. */
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin') ?? '';
  const referer = request.headers.get('Referer') ?? '';
  const selfOrigin = new URL(request.url).origin;
  // Origin header present: strict match
  if (origin) return origin === selfOrigin || ALLOWED_ORIGINS.includes(origin);
  // No Origin header (same-origin GET): fall back to Referer prefix match
  return referer.startsWith(selfOrigin) || ALLOWED_ORIGINS.some(a => referer.startsWith(a));
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const corsHeaders = buildCorsHeaders(request);

  // Handle OPTIONS preflight immediately
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Origin gate — only web UI can call /api/*
  if (url.pathname.startsWith('/api/') && !isAllowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden: origin not allowed' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await context.next();
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newHeaders.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
};
