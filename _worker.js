/**
 * Cloudflare Pages _worker.js
 * Works with BOTH GitHub-connected AND manual drag-and-drop deployments.
 * Handles /proxy route; all other requests served as static files via env.ASSETS.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only intercept /proxy requests
    if (url.pathname !== "/proxy") {
      return env.ASSETS.fetch(request);
    }

    const targetUrl = url.searchParams.get("url");

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!targetUrl) {
      return new Response("Missing url parameter", { status: 400, headers: corsHeaders });
    }

    const upstreamHeaders = {
      "User-Agent": request.headers.get("User-Agent") ||
        "ReactNativeVideo/9.11.1 (Linux;Android 13) AndroidXMedia3/1.6.1",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    };

    if (
      targetUrl.includes("fancode.com") ||
      targetUrl.includes("aiv-cdn.net") ||
      targetUrl.includes("aiv-cdn.com") ||
      targetUrl.includes("in-mc-flive") ||
      targetUrl.includes("in-mc-plive") ||
      targetUrl.includes("akamaized.net") ||
      targetUrl.includes("akamaihd.net")
    ) {
      upstreamHeaders["Referer"] = "https://fancode.com/";
      upstreamHeaders["Origin"] = "https://fancode.com";
    }

    const range = request.headers.get("Range");
    if (range) upstreamHeaders["Range"] = range;

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: upstreamHeaders,
        redirect: "follow",
      });

      const contentType = response.headers.get("content-type") || "";
      const isM3U8 =
        contentType.includes("mpegurl") ||
        contentType.includes("x-mpegurl") ||
        targetUrl.includes(".m3u8");

      let body;
      if (isM3U8) {
        let text = await response.text();
        const finalUrl = response.url || targetUrl;
        let baseUrl;
        try {
          const u = new URL(finalUrl);
          const pathDir = u.pathname.substring(0, u.pathname.lastIndexOf("/") + 1);
          baseUrl = u.origin + pathDir;
        } catch (_) {
          baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);
        }
        const proxyBase = url.origin + url.pathname;

        text = text.replace(/^(?!#)(\S+)$/gm, (match) => {
          const trimmed = match.trim();
          if (!trimmed) return match;
          const absolute = trimmed.startsWith("http://") || trimmed.startsWith("https://")
            ? trimmed
            : baseUrl + trimmed;
          return proxyBase + "?url=" + encodeURIComponent(absolute);
        });

        text = text.replace(/URI="([^"]+)"/g, (_m, uri) => {
          const absolute = uri.startsWith("http://") || uri.startsWith("https://")
            ? uri
            : baseUrl + uri;
          return `URI="${proxyBase}?url=${encodeURIComponent(absolute)}"`;
        });

        body = text;
      } else {
        body = response.body;
      }

      const responseHeaders = new Headers();
      for (const [k, v] of response.headers.entries()) {
        const kl = k.toLowerCase();
        if (kl !== "access-control-allow-origin" && kl !== "x-frame-options" && kl !== "content-security-policy") {
          responseHeaders.set(k, v);
        }
      }
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "*");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response("Proxy error: " + err.message, {
        status: 502,
        headers: corsHeaders,
      });
    }
  }
};
