import assert from "node:assert/strict";
import test from "node:test";
import { formatClock, renderSiteStats } from "./site-stats.mjs";

test("formatClock renders a Chinese date and time", () => {
  const clock = formatClock(new Date("2026-05-17T09:08:07+09:00"));

  assert.match(clock, /2026/);
  assert.match(clock, /05/);
  assert.match(clock, /17/);
  assert.match(clock, /09:08:07/);
});

test("renderSiteStats writes only the clock into the provided element", () => {
  const attributes = new Map();
  const clockElement = {
    textContent: "",
    setAttribute: (name, value) => attributes.set(name, value),
  };
  let fetchCalled = false;

  renderSiteStats({
    clockElement,
    now: () => new Date("2026-05-17T09:08:07+09:00"),
    fetcher: async () => {
      fetchCalled = true;
    },
    intervalMs: 0,
  });

  assert.match(clockElement.textContent, /09:08:07/);
  assert.equal(attributes.get("datetime"), "2026-05-17T00:08:07.000Z");
  assert.equal(fetchCalled, false);
});
