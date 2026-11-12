import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  armCacheKeepalive,
  disarmCacheKeepalive,
  isCacheKeepaliveArmed,
  setCacheKeepaliveClockForTests,
  type CacheKeepaliveRefreshOutcome,
} from "../../src/server/responses/cache-keepalive";

const SEC = 1000;
const MIN = 60 * SEC;
const PLAN = { intervalMs: 270 * SEC, maxIdleMs: 30 * MIN, minContextTokens: 30_000 };

let now = 0;
let timers: Array<{ at: number; fn: () => void; id: number }> = [];
let nextId = 1;

/** Advance the fake clock, firing due timers in order and letting their refreshes settle. */
async function advanceTo(target: number): Promise<void> {
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const due = timers[0];
    if (!due || due.at > target) break;
    timers.shift();
    now = due.at;
    due.fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  now = target;
}

beforeEach(() => {
  now = 0;
  timers = [];
  setCacheKeepaliveClockForTests({
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: timer => { timers = timers.filter(entry => entry.id !== (timer as unknown as number)); },
  });
});

afterEach(() => setCacheKeepaliveClockForTests(undefined));

function arm(lastCallAt: number, refresh: () => Promise<CacheKeepaliveRefreshOutcome>, context = 100_000) {
  armCacheKeepalive("thread-a", { plan: PLAN, lastCallAt, contextTokens: () => context, refresh });
}

test("refreshes every 270s and stops before the next one would leave the 30-minute window", async () => {
  const at: number[] = [];
  arm(0, async () => { at.push(now); return { ok: true, cacheWriteTokens: 0 }; });
  await advanceTo(40 * MIN);
  expect(at.map(t => t / SEC)).toEqual([270, 540, 810, 1080, 1350, 1620]);
  expect(isCacheKeepaliveArmed("thread-a")).toBe(false);
});

test("a new call restarts the window from its own start time", async () => {
  const at: number[] = [];
  const refresh = async () => { at.push(now); return { ok: true, cacheWriteTokens: 0 }; };
  arm(0, refresh);
  await advanceTo(400 * SEC);
  arm(400 * SEC, refresh);
  await advanceTo(60 * MIN);
  expect(at.map(t => t / SEC)).toEqual([270, 670, 940, 1210, 1480, 1750, 2020]);
});

test("a refresh that wrote to the cache, or failed, ends the keepalive", async () => {
  let calls = 0;
  arm(0, async () => { calls++; return { ok: true, cacheWriteTokens: 1200 }; });
  await advanceTo(30 * MIN);
  expect(calls).toBe(1);
  expect(isCacheKeepaliveArmed("thread-a")).toBe(false);

  calls = 0;
  arm(now, async () => { calls++; return { ok: false }; });
  await advanceTo(now + 30 * MIN);
  expect(calls).toBe(1);
  expect(isCacheKeepaliveArmed("thread-a")).toBe(false);
});

test("a small context is never refreshed, and disarm cancels a pending refresh", async () => {
  let calls = 0;
  arm(0, async () => { calls++; return { ok: true }; }, 5_000);
  await advanceTo(30 * MIN);
  expect(calls).toBe(0);

  arm(now, async () => { calls++; return { ok: true }; });
  disarmCacheKeepalive("thread-a");
  await advanceTo(now + 30 * MIN);
  expect(calls).toBe(0);
});
