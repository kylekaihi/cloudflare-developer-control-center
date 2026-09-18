import assert from "node:assert/strict";
import test from "node:test";
import { collectAlerts, readAlertRules } from "./alerts.mjs";

test("reads bounded custom alert thresholds", () => {
  const rules = readAlertRules(JSON.stringify({ cpu: { warning: 70, critical: 88 }, serviceDown: { enabled: false } }));
  assert.equal(rules.cpu.warning, 70);
  assert.equal(rules.cpu.critical, 88);
  assert.equal(rules.serviceDown.enabled, false);
});

test("uses custom thresholds and can disable service alerts", () => {
  const alerts = collectAlerts(
    { cpuPercent: 75, memoryPercent: 91, diskPercent: 40 },
    [{ name: "Stopped", status: "down" }],
    readAlertRules(JSON.stringify({ cpu: { warning: 70, critical: 80 }, serviceDown: { enabled: false } })),
  );
  assert.deepEqual(alerts.map((alert) => alert.code), ["cpu_high", "memory_high"]);
  assert.equal(alerts[0].severity, "warning");
});
