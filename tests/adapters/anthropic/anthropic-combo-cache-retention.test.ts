/**
 * TTL variants of one Anthropic model: single-target combos whose `cacheRetention` fixes the
 * prompt-cache TTL, published under names next to the base model. The wire model stays the
 * base id, so switching a thread between variants keeps the same upstream model and prefix.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState } from "../../../src/combos/resolve";
import { clearComboTargetCooldowns } from "../../../src/combos/failover";
import { comboConfigIssues } from "../../../src/combos/types";
import { clearAnthropicAccountPoolState } from "../../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearResponseStateForTests, flushResponseState } from "../../../src/responses/state";
import { handleResponses } from "../../../src/server/responses";
import { isCacheKeepaliveArmed, setCacheKeepaliveClockForTests } from "../../../src/server/responses/cache-keepalive";
import { readUsageEntries } from "../../../src/usage/log";
import type { RequestLogContext } from "../../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const MODEL = "claude-opus-5-5";
const TTL60 = "anthropic/claude-opus-5-5-ttl60";
const TTL5 = "anthropic/claude-opus-5-5-ttl5";

type Breakpoint = { type: string; ttl?: string };
type SentBody = {
  model: string;
  cache_control?: Breakpoint;
  system?: Array<{ cache_control?: Breakpoint }>;
  tools?: Array<{ cache_control?: Breakpoint }>;
  messages: Array<{ content: string | Array<{ cache_control?: Breakpoint }> }>;
};

const originalHome = process.env.OPENCODEX_HOME;
let home = "";
let releaseSpendHome: (() => void) | undefined;
let sent: SentBody[] = [];

function configFor(): OcxConfig {
  const transport = (async (_input, init) => {
    const sentBody = JSON.parse(String(init?.body)) as SentBody & { max_tokens?: number };
    sent.push(sentBody);
    if (sentBody.max_tokens === 0) {
      // Anthropic's documented pre-warm answer: no content, a full cache read, nothing written.
      return Response.json({
        id: "msg_prewarm", type: "message", role: "assistant", model: MODEL, content: [],
        stop_reason: "max_tokens",
        usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
      });
    }
    return Response.json({
      id: "msg_synthetic", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 2 },
    });
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth",
    models: [MODEL], fetch: transport,
  };
  return {
    port: 0, defaultProvider: "anthropic",
    providers: { anthropic: provider },
    cacheRetention: "hybrid",
    subagentCacheRetention: "short",
    combos: {
      "opus-ttl60": { alias: TTL60, targets: [{ provider: "anthropic", model: MODEL }], cacheRetention: "long" },
      "opus-ttl5": { alias: TTL5, targets: [{ provider: "anthropic", model: MODEL }], cacheRetention: "short" },
    },
  };
}

/** Mid-loop turn: a human message, one tool call and its output, so hybrid and long differ. */
async function post(config: OcxConfig, model: string, headers: Record<string, string> = {}) {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      stream: false,
      instructions: "system prompt",
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "H1" }] },
        { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "out" },
      ],
    }),
  }), config, logCtx);
  expect(response.status).toBe(200);
  await response.text();
  return { body: sent.at(-1)!, logCtx };
}

/** TTL of every explicit breakpoint, "5m" when the default ttl is used. */
function explicitTtls(body: SentBody): string[] {
  const ttls: string[] = [];
  const add = (cc?: Breakpoint) => { if (cc) ttls.push(cc.ttl ?? "5m"); };
  for (const block of body.tools ?? []) add(block.cache_control);
  for (const block of body.system ?? []) add(block.cache_control);
  for (const message of body.messages) {
    if (Array.isArray(message.content)) for (const block of message.content) add(block.cache_control);
  }
  return ttls;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-combo-ttl-"));
  process.env.OPENCODEX_HOME = home;
  sent = [];
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearAnthropicAccountPoolState();
  clearResponseStateForTests();
  releaseSpendHome = acquireOwnedSpendHome();
  await saveCredential("anthropic", {
    access: "synthetic-anthropic-access",
    refresh: "synthetic-anthropic-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-account",
  });
  await setActiveAccount("anthropic", getAccountSet("anthropic")!.accounts[0]!.id);
});

afterEach(async () => {
  await flushResponseState();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearAnthropicAccountPoolState();
  clearResponseStateForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (home) removeTreeWithRetry(home);
});

test("the ttl60 variant sends the base model with every breakpoint at 1h", async () => {
  const { body, logCtx } = await post(configFor(), TTL60);
  expect(body.model).toBe(MODEL);
  expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(explicitTtls(body).length).toBeGreaterThan(0);
  expect(explicitTtls(body).every(ttl => ttl === "1h")).toBe(true);
  expect(logCtx.cacheRetentionOverride).toBe("long");
});

test("the ttl5 variant sends the base model with every breakpoint at 5m", async () => {
  const { body, logCtx } = await post(configFor(), TTL5);
  expect(body.model).toBe(MODEL);
  expect(body.cache_control).toEqual({ type: "ephemeral" });
  expect(explicitTtls(body).every(ttl => ttl === "5m")).toBe(true);
  expect(logCtx.cacheRetentionOverride).toBe("short");
});

test("the base model keeps the global hybrid policy and carries no override", async () => {
  const { body, logCtx } = await post(configFor(), `anthropic/${MODEL}`);
  expect(body.model).toBe(MODEL);
  expect(body.cache_control).toEqual({ type: "ephemeral" });
  expect(explicitTtls(body)).toContain("1h");
  expect(logCtx.cacheRetentionOverride).toBeUndefined();
});

test("an explicitly chosen variant wins over the sub-agent default", async () => {
  const { body, logCtx } = await post(configFor(), TTL60, { "x-openai-subagent": "collab_spawn" });
  expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(logCtx.cacheRetentionOverride).toBe("long");

  const base = await post(configFor(), `anthropic/${MODEL}`, { "x-openai-subagent": "collab_spawn" });
  expect(explicitTtls(base.body).every(ttl => ttl === "5m")).toBe(true);
  expect(base.logCtx.cacheRetentionOverride).toBe("short");
});

test("combo validation rejects an unknown cacheRetention", () => {
  const providers = configFor().providers;
  const issues = comboConfigIssues("bad", {
    targets: [{ provider: "anthropic", model: MODEL }],
    cacheRetention: "forever" as never,
  }, providers);
  expect(issues.map(issue => issue.path.join("."))).toContain("cacheRetention");
});

describe("ttl5-ping30 keepalive", () => {
  const PING30 = "anthropic/claude-opus-5-5-ttl5-ping30";
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextTimerId = 1;

  beforeEach(() => {
    now = Date.now();
    timers = [];
    setCacheKeepaliveClockForTests({
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextTimerId++;
        timers.push({ at: now + ms, fn, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: timer => { timers = timers.filter(entry => entry.id !== (timer as unknown as number)); },
    });
  });
  afterEach(() => setCacheKeepaliveClockForTests(undefined));

  function pingConfig(): OcxConfig {
    const config = configFor();
    config.combos!["opus-ttl5-ping30"] = {
      alias: PING30,
      targets: [{ provider: "anthropic", model: MODEL }],
      cacheRetention: "short",
      cacheKeepalive: { intervalSec: 270, maxIdleMin: 30, minContextTokens: 0 },
    };
    return config;
  }

  async function fireNextTimer(): Promise<void> {
    timers.sort((a, b) => a.at - b.at);
    const due = timers.shift();
    if (!due) throw new Error("no keepalive timer armed");
    now = due.at;
    const before = sent.length;
    due.fn();
    for (let i = 0; i < 200 && (sent.length === before || timers.length === 0); i++) await Bun.sleep(2);
  }

  test("a refresh replays the last call as a zero-output pre-warm with an identical prompt", async () => {
    const config = pingConfig();
    const first = await post(config, PING30, { "thread-id": "thread-ping" });
    expect(isCacheKeepaliveArmed("thread-ping")).toBe(true);
    expect(timers).toHaveLength(1);
    // Anchored to the call's start (real clock), so a few milliseconds past the fake "now".
    expect(timers[0]!.at - now).toBeGreaterThanOrEqual(270_000);
    expect(timers[0]!.at - now).toBeLessThan(271_000);

    await fireNextTimer();
    expect(sent).toHaveLength(2);
    const ping = sent[1]!;
    expect((ping as { max_tokens?: number }).max_tokens).toBe(0);
    expect((ping as { stream?: boolean }).stream).toBe(false);
    const strip = (body: SentBody) => {
      const { max_tokens: _max, stream: _stream, ...rest } = body as SentBody & { max_tokens?: number; stream?: boolean };
      return JSON.stringify(rest);
    };
    expect(strip(ping)).toBe(strip(first.body));
    // The refresh read everything and wrote nothing, so the next one is scheduled.
    expect(isCacheKeepaliveArmed("thread-ping")).toBe(true);
    expect(timers).toHaveLength(1);

    const rows = readUsageEntries().filter(row => row.cacheKeepalive === true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestedModel).toBe(`anthropic/${MODEL}`);
    expect(rows[0]?.cacheRetentionOverride).toBe("short");
  });

  test("a call through another model on the same thread stops the refreshes", async () => {
    const config = pingConfig();
    await post(config, PING30, { "thread-id": "thread-switch" });
    expect(isCacheKeepaliveArmed("thread-switch")).toBe(true);
    await post(config, TTL5, { "thread-id": "thread-switch" });
    expect(isCacheKeepaliveArmed("thread-switch")).toBe(false);
    expect(timers).toHaveLength(0);
  });

  test("validation rejects keepalive on a 1-hour cache", () => {
    const issues = comboConfigIssues("bad", {
      targets: [{ provider: "anthropic", model: MODEL }],
      cacheRetention: "long",
      cacheKeepalive: { intervalSec: 270 },
    }, configFor().providers);
    expect(issues.map(issue => issue.path.join("."))).toContain("cacheKeepalive");
  });
});
