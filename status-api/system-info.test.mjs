import assert from "node:assert/strict";
import test from "node:test";
import { calculateCpuPercent, collectNodeInfo, collectSystemMetrics } from "./system-info.mjs";

test("calculates CPU utilization from cumulative CPU time and bounds it at 100%", () => {
  assert.equal(calculateCpuPercent({ total: 100, idle: 60 }, { total: 200, idle: 100 }), 60);
  assert.equal(calculateCpuPercent({ total: 100, idle: 60 }, { total: 110, idle: 40 }), 100);
  assert.equal(calculateCpuPercent(null, { total: 200, idle: 100 }), null);
});

test("collects bounded read-only VPS diagnostics", () => {
  const system = collectSystemMetrics();
  const node = collectNodeInfo();
  assert.equal(Number.isFinite(system.memoryBytes.total), true);
  assert.equal(system.loadAverages.length, 3);
  assert.equal(system.cpuPercent === null || (system.cpuPercent >= 0 && system.cpuPercent <= 100), true);
  assert.equal(typeof node.hostname, "string");
  assert.equal(Number.isInteger(node.cpu.logicalCores), true);
  assert.equal(node.storage.length <= 16, true);
  assert.equal(node.network.length <= 32, true);
  assert.equal(node.network.every((item) => !/^169\.254\./.test(item.address)), true);
});
