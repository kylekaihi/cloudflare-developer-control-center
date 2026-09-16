import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dashboardAssets = join(root, "public", "dashboard");
const manifest = JSON.parse(readFileSync(join(dashboardAssets, "manifest.webmanifest"), "utf8"));
const serviceWorker = readFileSync(join(dashboardAssets, "sw.js"), "utf8");

test("PWA manifest provides installable and maskable application icons", () => {
  assert.equal(manifest.id, "/dashboard/");
  assert.equal(manifest.scope, "/dashboard/");
  assert.match(manifest.start_url, /^\/dashboard\//);
  assert.equal(manifest.display, "standalone");

  const requiredIcons = [
    ["192x192", "any"],
    ["512x512", "any"],
    ["512x512", "maskable"],
  ];
  for (const [sizes, purpose] of requiredIcons) {
    const icon = manifest.icons.find((item) => item.sizes === sizes && item.purpose === purpose);
    assert.ok(icon, `missing ${sizes} ${purpose} icon`);
    assert.ok(existsSync(join(root, "public", icon.src)), `${icon.src} does not exist`);
  }
});

test("PWA shell has an offline fallback and never caches status API responses", () => {
  assert.ok(existsSync(join(dashboardAssets, "offline.html")));
  assert.match(serviceWorker, /requestUrl\.pathname\.startsWith\("\/dashboard\/api\/"\)/);
  assert.match(serviceWorker, /JSON\.stringify\(\{ error: "Offline", offline: true \}\)/);

  const apiBranchStart = serviceWorker.indexOf('requestUrl.pathname.startsWith("/dashboard/api/")');
  const navigationBranchStart = serviceWorker.indexOf('event.request.mode === "navigate"', apiBranchStart);
  const apiBranch = serviceWorker.slice(apiBranchStart, navigationBranchStart);
  assert.doesNotMatch(apiBranch, /cache\.put/);
  assert.match(serviceWorker, /caches\.match\(OFFLINE_URL\)/);
});

test("PWA update lifecycle supports explicit activation", () => {
  assert.match(serviceWorker, /SKIP_WAITING/);
assert.match(serviceWorker, /SW_ACTIVATED/);
assert.match(serviceWorker, /addEventListener\("push"/);
assert.match(serviceWorker, /showNotification/);
assert.match(serviceWorker, /addEventListener\("notificationclick"/);
  assert.match(serviceWorker, /CACHE_PREFIX/);
});

test("PWA caches hashed Astro assets without admitting API routes", () => {
  assert.match(serviceWorker, /CACHE_STATIC_ASSETS/);
  assert.match(serviceWorker, /pathname\.startsWith\("\/_astro\/"\)/);
  const staticAssetBranch = serviceWorker.slice(serviceWorker.indexOf('event.data?.type === "CACHE_STATIC_ASSETS"'));
  assert.doesNotMatch(staticAssetBranch, /dashboard\/api/);
});
