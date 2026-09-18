import assert from "node:assert/strict";
import test from "node:test";
import { dockerDiscoveryArgs, mergeServices } from "./discovery.mjs";

test("replace discovery mode removes stale configured services", () => {
  const result = mergeServices(
    [{ name: "Removed service", status: "down" }],
    [{ name: "Running container", status: "up" }],
    "replace",
  );
  assert.deepEqual(result.map((service) => service.name), ["Running container"]);
});

test("running Docker discovery does not include stopped containers", () => {
  assert.deepEqual(dockerDiscoveryArgs("running"), ["ps", "--format", "{{.Names}}\\t{{.State}}\\t{{.Image}}\\t{{.Status}}"]);
  assert.deepEqual(dockerDiscoveryArgs("all")[0], "ps");
  assert.deepEqual(dockerDiscoveryArgs("all")[1], "-a");
});
