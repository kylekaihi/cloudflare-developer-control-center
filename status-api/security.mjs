import { randomUUID, timingSafeEqual } from "node:crypto";

export function matchesServiceToken(provided, current, previous = "") {
  const candidate = Buffer.from(String(provided || ""));
  return [current, previous].some((value) => {
    const expected = Buffer.from(String(value || ""));
    return expected.length >= 32 && candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

export function isAllowedServiceUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (!host.includes(".") && /^[a-z0-9][a-z0-9-]{0,62}$/.test(host)) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

export function normalizeRequestId(value) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
}
