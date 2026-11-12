/**
 * Prompt-cache keepalive scheduler (one timer per Codex thread).
 *
 * Anthropic's 5-minute prompt cache expires when a thread sits idle, after which the next call
 * rewrites the whole prefix at the cache-write rate. A refresh re-sends the thread's last request
 * as a pre-warm (`max_tokens: 0`): it reads the cached prefix, which renews its TTL, and bills
 * no output. The window is anchored to the thread's last REAL call: every call re-arms the
 * entry, and refreshes stop once the next one would fall outside `maxIdleMs` of that call.
 *
 * A refresh that wrote anything (the prefix had already expired or no longer matched) or failed
 * ends the entry, since repeating it cannot help. State is process-local and bounded; a restart
 * simply forgets every timer.
 */

export interface CacheKeepalivePlan {
  intervalMs: number;
  maxIdleMs: number;
  minContextTokens: number;
}

export interface CacheKeepaliveRefreshOutcome {
  ok: boolean;
  /** Tokens the refresh wrote to the cache; any write ends the entry. */
  cacheWriteTokens?: number;
}

export interface CacheKeepaliveRegistration {
  plan: CacheKeepalivePlan;
  /** Start time of the real call that armed this entry. */
  lastCallAt: number;
  /** Input size of the last real call once known; undefined means not yet reported. */
  contextTokens: () => number | undefined;
  refresh: () => Promise<CacheKeepaliveRefreshOutcome>;
}

interface Entry extends CacheKeepaliveRegistration {
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Clock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

const MAX_ENTRIES = 64;
const defaultClock: Clock = {
  now: Date.now,
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // A pending refresh must never keep the process alive on shutdown.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: timer => clearTimeout(timer),
};
let clock: Clock = defaultClock;
const entries = new Map<string, Entry>();

function schedule(key: string, entry: Entry, at: number): void {
  if (at - entry.lastCallAt > entry.plan.maxIdleMs) {
    disarmCacheKeepalive(key);
    return;
  }
  entry.timer = clock.setTimeout(() => { void fire(key, entry); }, Math.max(0, at - clock.now()));
}

async function fire(key: string, entry: Entry): Promise<void> {
  if (entries.get(key) !== entry) return;
  entry.timer = undefined;
  const context = entry.contextTokens();
  if (context !== undefined && context < entry.plan.minContextTokens) {
    disarmCacheKeepalive(key);
    return;
  }
  const startedAt = clock.now();
  let outcome: CacheKeepaliveRefreshOutcome;
  try {
    outcome = await entry.refresh();
  } catch {
    outcome = { ok: false };
  }
  // A real call during the refresh re-armed the thread; the newer entry owns it now.
  if (entries.get(key) !== entry) return;
  if (!outcome.ok || (outcome.cacheWriteTokens ?? 0) > 0) {
    disarmCacheKeepalive(key);
    return;
  }
  schedule(key, entry, startedAt + entry.plan.intervalMs);
}

/** Arm (or re-arm) the thread's keepalive from the start time of its latest real call. */
export function armCacheKeepalive(key: string, registration: CacheKeepaliveRegistration): void {
  disarmCacheKeepalive(key);
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    disarmCacheKeepalive(oldest);
  }
  const entry: Entry = { ...registration, timer: undefined };
  entries.set(key, entry);
  schedule(key, entry, registration.lastCallAt + registration.plan.intervalMs);
}

/** Stop refreshing a thread, for example when its next call uses a model without keepalive. */
export function disarmCacheKeepalive(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
  entries.delete(key);
}

export function isCacheKeepaliveArmed(key: string): boolean {
  return entries.has(key);
}

export function setCacheKeepaliveClockForTests(next: Clock | undefined): void {
  for (const key of [...entries.keys()]) disarmCacheKeepalive(key);
  clock = next ?? defaultClock;
}
