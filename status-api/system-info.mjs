import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

let previousCpuTimes = readCpuTimes();

export function collectSystemMetrics() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const loadAverages = os.loadavg().map(round);
  const currentCpuTimes = readCpuTimes();
  const cpuPercent = calculateCpuPercent(previousCpuTimes, currentCpuTimes);
  previousCpuTimes = currentCpuTimes;
  return {
    cpuPercent,
    memoryPercent: round(((totalMemory - freeMemory) / totalMemory) * 100),
    diskPercent: readRootDiskPercent(),
    uptimeSeconds: Math.round(os.uptime()),
    loadAverages,
    memoryBytes: { total: totalMemory, used: totalMemory - freeMemory, free: freeMemory },
  };
}

export function calculateCpuPercent(previous, current) {
  if (!previous || !current) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (!Number.isFinite(totalDelta) || !Number.isFinite(idleDelta) || totalDelta <= 0) return null;
  return round(Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)));
}

function readCpuTimes() {
  try {
    const values = readFileSync("/proc/stat", "utf8").match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
    if (values?.length >= 4 && values.every(Number.isFinite)) {
      return { total: values.reduce((sum, value) => sum + value, 0), idle: values[3] + (values[4] || 0) };
    }
  } catch {
    // Non-Linux fallback below.
  }
  const times = os.cpus().map((cpu) => cpu.times);
  if (!times.length) return null;
  return times.reduce((result, value) => ({
    total: result.total + value.user + value.nice + value.sys + value.idle + value.irq,
    idle: result.idle + value.idle,
  }), { total: 0, idle: 0 });
}

export function collectNodeInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    kernelRelease: os.release(),
    architecture: os.arch(),
    distribution: readDistribution(),
    cpu: { model: cpus[0]?.model?.trim() || "unknown", logicalCores: cpus.length },
    storage: readStorage(),
    network: readPrivateNetworkInterfaces(),
  };
}

function readDistribution() {
  try {
    const fields = Object.fromEntries(readFileSync("/etc/os-release", "utf8").split("\n").map((line) => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].replace(/^"|"$/g, "")]));
    return fields.PRETTY_NAME || fields.NAME || "Linux";
  } catch {
    return "Linux";
  }
}

function readStorage() {
  try {
    const output = execFileSync("df", ["-Pk"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    return output.trim().split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 6).map(([filesystem, blocks, used, available, percent, ...mountParts]) => ({
      filesystem: String(filesystem).slice(0, 128),
      mount: mountParts.join(" ").slice(0, 256),
      totalBytes: Number(blocks) * 1024,
      usedBytes: Number(used) * 1024,
      availableBytes: Number(available) * 1024,
      usedPercent: Number(percent.replace("%", "")),
    })).filter((item) => Number.isFinite(item.totalBytes) && !/^(tmpfs|devtmpfs)$/.test(item.filesystem)).slice(0, 16);
  } catch {
    return [];
  }
}

function readRootDiskPercent() {
  return readStorage().find((item) => item.mount === "/")?.usedPercent ?? null;
}

function readPrivateNetworkInterfaces() {
  try {
    return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => (addresses || []).filter((address) => !address.internal && isPrivateAddress(address.address)).map((address) => ({
      name: String(name).slice(0, 64),
      address: address.address,
      family: address.family,
      cidr: address.cidr || null,
    }))).slice(0, 32);
  } catch {
    return [];
  }
}

function isPrivateAddress(address) {
  if (address.includes(":")) return /^(fc|fd|fe80:)/i.test(address);
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}
