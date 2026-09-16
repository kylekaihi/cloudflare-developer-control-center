export async function hasValidAccessIdentity(request, env) {
  return Boolean(await readAccessIdentity(request, env));
}

export async function readAccessIdentity(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || readAccessCookie(request.headers.get("Cookie") || "");
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = String(env.ACCESS_AUD || "").trim();
  if (!token || !teamDomain || !audience) return null;

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = JSON.parse(decodeBase64Url(encodedHeader));
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    if (header.alg !== "RS256" || !header.kid) return null;
    if (payload.exp * 1_000 <= Date.now()) return null;
    if (payload.iss !== `https://${teamDomain}`) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) return null;

    const certResponse = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!certResponse.ok) return null;
    const certs = await certResponse.json();
    const jwk = Array.isArray(certs.keys) ? certs.keys.find((key) => key.kid === header.kid) : null;
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!valid) return null;
    return { email: typeof payload.email === "string" ? payload.email.slice(0, 254) : null, subject: typeof payload.sub === "string" ? payload.sub.slice(0, 254) : null };
  } catch {
    return null;
  }
}

function readAccessCookie(cookie) {
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : "";
}

function decodeBase64Url(value) {
  return new TextDecoder().decode(decodeBytes(value));
}

function decodeBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
