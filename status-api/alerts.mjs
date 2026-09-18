const DEFAULT_RULES = {
  cpu: { warning: 90, critical: 95 },
  memory: { warning: 90, critical: 95 },
  disk: { warning: 85, critical: 95 },
  serviceDown: { enabled: true },
};

export function readAlertRules(value) {
  let source = {};
  try {
    const parsed = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) source = parsed;
  } catch {
    source = {};
  }
  return {
    cpu: normalizeThresholds(source.cpu, DEFAULT_RULES.cpu),
    memory: normalizeThresholds(source.memory, DEFAULT_RULES.memory),
    disk: normalizeThresholds(source.disk, DEFAULT_RULES.disk),
    serviceDown: { enabled: source.serviceDown?.enabled !== false },
  };
}

export function collectAlerts(system, monitoredServices, rules = DEFAULT_RULES) {
  const alerts = [];
  addThreshold(alerts, system?.cpuPercent, rules.cpu, "cpu_high", "CPU usage is high");
  addThreshold(alerts, system?.memoryPercent, rules.memory, "memory_high", "Memory usage is high");
  addThreshold(alerts, system?.diskPercent, rules.disk, "disk_high", "Disk usage is high");
  if (rules.serviceDown.enabled) {
    for (const service of monitoredServices || []) {
      if (service.status !== "up") {
        alerts.push({ severity: "critical", code: "service_down", message: `${service.name} is unavailable`, createdAt: new Date().toISOString() });
      }
    }
  }
  return alerts;
}

function addThreshold(alerts, value, threshold, code, message) {
  if (typeof value !== "number" || value < threshold.warning) return;
  alerts.push({
    severity: value >= threshold.critical ? "critical" : "warning",
    code,
    message: `${message}: ${value}%`,
    createdAt: new Date().toISOString(),
  });
}

function normalizeThresholds(value, fallback) {
  const warning = bounded(value?.warning, fallback.warning);
  return { warning, critical: Math.max(warning, bounded(value?.critical, fallback.critical)) };
}

function bounded(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : fallback;
}
