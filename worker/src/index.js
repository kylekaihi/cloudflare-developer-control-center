const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const ALLOWED_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return textResponse("Use POST", 405);
    }

    if (!(await hasValidToken(request, env.UPLOAD_TOKEN))) {
      return textResponse("Unauthorized", 401);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    const maxBytes = Number(env.MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
    if (contentLength && contentLength > maxBytes) {
      return textResponse("Image is too large", 413);
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return textResponse("Expected multipart form data", 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return textResponse("Missing file", 400);
    }

    if (file.size > maxBytes) {
      return textResponse("Image is too large", 413);
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return textResponse("Unsupported image type", 415);
    }

    const key = buildObjectKey(file.name);
    await env.BLOG_IMAGES.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type,
        cacheControl: env.CACHE_CONTROL || DEFAULT_CACHE_CONTROL,
      },
    });

    const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key}`;
    const alt = key
      .split("/")
      .at(-1)
      .replace(/^\d{4}-\d{2}-\d{2}-[a-f0-9-]+-/, "")
      .replace(/\.[^.]+$/, "")
      .replace(/-/g, " ");

    return jsonResponse({
      key,
      url,
      markdown: `![${alt}](${url})`,
    });
  },
};

function buildObjectKey(filename) {
  const date = new Date().toISOString().slice(0, 10);
  const id = crypto.randomUUID().slice(0, 8);
  const safeName = sanitizeFilename(filename || "image.jpg");
  return `images/${date}-${id}-${safeName}`;
}

function sanitizeFilename(filename) {
  const lower = filename.toLowerCase();
  const normalized = lower
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "");

  return normalized || "image.jpg";
}

async function hasValidToken(request, expectedToken) {
  const header = request.headers.get("Authorization") || "";
  const actualToken = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!expectedToken || !actualToken) {
    return false;
  }

  const encoder = new TextEncoder();
  const actual = encoder.encode(actualToken);
  const expected = encoder.encode(expectedToken);

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(actual, expected) {
  let diff = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);

  for (let index = 0; index < length; index += 1) {
    diff |= (actual[index] || 0) ^ (expected[index] || 0);
  }

  return diff === 0;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function textResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  };
}
