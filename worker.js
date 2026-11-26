/* =====================================================================
   Bosla | بوصلة — AI proxy (Cloudflare Worker)
   ---------------------------------------------------------------------
   What it does, in short:
     The website sends its Gemini request HERE (not to Google).
     This Worker adds the secret key GEMINI_API_KEY and forwards the
     request to the Gemini API, then returns Gemini's answer unchanged.
     So every visitor gets real AI, and the key never appears in the site.

   Setup (once):
     1. Cloudflare dashboard → Workers & Pages → Create → Worker → Deploy.
     2. "Edit code" → delete everything → paste this whole file → Deploy.
     3. Worker → Settings → Variables and Secrets → Add →
        Type: Secret, Name: GEMINI_API_KEY, Value: your key → Deploy.
     4. Copy the Worker address (https://....workers.dev) into AI_PROXY_URL
        at the top of the site's script.

   Safety rules:
     • Only these websites may call it (CORS):
         https://bosla-7c7c1.web.app
         https://bosla-7c7c1.firebaseapp.com
         http://localhost  (any port, for testing on your computer)
     • Only POST requests to /v1beta/models/<model>:generateContent
     • Request bodies over 8 MB are rejected.
   ===================================================================== */

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB

const ALLOWED_ORIGINS = [
  "https://bosla-7c7c1.web.app",
  "https://bosla-7c7c1.firebaseapp.com"
];

// The only path the site needs: /v1beta/models/<model name>:generateContent
const PATH_PATTERN = /^\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/;

// Is this website allowed to use the Worker?
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/localhost(:\d{1,5})?$/.test(origin); // http://localhost or http://localhost:8000 ...
}

// The CORS headers that let the allowed website read the answer.
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

// A small JSON error in the same shape Gemini uses: { error: { code, message } }
function errorResponse(status, message, origin) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify({ error: { code: status, message } }), { status, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = isAllowedOrigin(origin);

    // 1) Browsers first send an OPTIONS "preflight" request to ask for permission.
    if (request.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 2) Only our websites may use this Worker.
    if (!allowed) return errorResponse(403, "This origin is not allowed.", null);

    // 3) Only POST to the generateContent path.
    if (request.method !== "POST") return errorResponse(405, "Only POST is allowed.", origin);
    const url = new URL(request.url);
    if (!PATH_PATTERN.test(url.pathname)) return errorResponse(404, "Unknown path.", origin);

    // 4) The secret key must be set in the Worker settings.
    if (!env.GEMINI_API_KEY) return errorResponse(500, "GEMINI_API_KEY is not set on the server.", origin);

    // 5) Reject bodies over 8 MB (checked before AND after reading).
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_BODY_BYTES) return errorResponse(413, "The request is larger than 8 MB.", origin);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return errorResponse(413, "The request is larger than 8 MB.", origin);

    // 6) Forward to Gemini with the secret key.
    let upstream;
    try {
      upstream = await fetch(GEMINI_BASE + url.pathname, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body
      });
    } catch (error) {
      return errorResponse(502, "Could not reach the Gemini API.", origin);
    }

    // 7) Return Gemini's answer unchanged (same status and body), plus CORS headers.
    const headers = corsHeaders(origin);
    headers["Content-Type"] = upstream.headers.get("Content-Type") || "application/json; charset=utf-8";
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
