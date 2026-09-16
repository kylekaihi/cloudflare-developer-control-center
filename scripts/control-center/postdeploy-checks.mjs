export function validateStatusPayload(payload, expectedHosts = []) {
  const errors = [];
  const hosts = Array.isArray(payload?.hosts) ? payload.hosts : [];
  if (hosts.length < 1) errors.push(`expected at least 1 host, received ${hosts.length}`);
  const hostNames = hosts.map((host) => host?.host).filter(Boolean);
  if (new Set(hostNames).size !== hostNames.length) errors.push("status payload contains duplicate hosts");
  for (const expected of expectedHosts) if (!hostNames.includes(expected)) errors.push(`missing host ${expected}`);
  const unreachable = hosts.filter((host) => !host?.reachable).map((host) => host?.host || "unknown");
  if (unreachable.length) errors.push(`unreachable hosts: ${unreachable.join(", ")}`);
  if (!payload?.generatedAt) errors.push("generatedAt is missing");
  return errors;
}

export function isAccessProtectedResponse(status, location = "") {
  return [301, 302, 303, 307, 308, 401, 403].includes(Number(status))
    && (Number(status) >= 400 || /cloudflareaccess\.com|cdn-cgi\/access/i.test(location));
}

export function hasCronSchedule(payload, expectedCron) {
  const schedules = Array.isArray(payload) ? payload : payload?.schedules;
  return Array.isArray(schedules) && schedules.some((schedule) => schedule?.cron === expectedCron);
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest?.id !== "/dashboard/") errors.push("manifest id is incorrect");
  if (manifest?.scope !== "/dashboard/") errors.push("manifest scope is incorrect");
  if (!Array.isArray(manifest?.icons) || !manifest.icons.some((icon) => icon.purpose === "maskable")) errors.push("maskable icon is missing");
  return errors;
}

export function readExpectedHosts(workerConfig) {
  try {
    const hosts = JSON.parse(workerConfig?.vars?.STATUS_SERVICE_HOSTS || "[]");
    return Array.isArray(hosts) ? hosts : [];
  } catch {
    return [];
  }
}
