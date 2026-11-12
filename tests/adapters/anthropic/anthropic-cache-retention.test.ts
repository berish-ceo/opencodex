import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../../../src/adapters/anthropic";
import type { OcxCacheRetention, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const NATIVE = "https://api.anthropic.com";
const GATEWAY = "https://gateway.example.test/v1";

function adapterFor(retention: OcxCacheRetention | undefined, baseUrl = NATIVE) {
  const provider = { adapter: "anthropic", baseUrl, authMode: "key", apiKey: "k", defaultMaxOutputTokens: 4096 } as OcxProviderConfig;
  return withTestTranslatorBudget(createAnthropicAdapterProduction(provider, retention));
}

const human = (text: string): OcxMessage => ({ role: "user", content: text, timestamp: 0 });
const call = (id: string): OcxMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "shell", arguments: { cmd: "ls" } }],
  timestamp: 0,
});
const result = (id: string): OcxMessage => ({
  role: "toolResult", toolCallId: id, toolName: "shell", content: "out", isError: false, timestamp: 0,
});
const answer = (text: string): OcxMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 });

// Previous turn (H1 + tool loop + final answer), then the current turn mid-loop.
const MID_LOOP: OcxMessage[] = [human("H1"), call("c1"), result("c1"), answer("A1"), human("H2"), call("c2"), result("c2")];
// First request of a new turn: the newest human message is the final message.
const TURN_START: OcxMessage[] = [human("H1"), call("c1"), result("c1"), answer("A1"), human("H2")];

function request(messages: OcxMessage[], override?: OcxCacheRetention): OcxParsedRequest {
  return {
    modelId: "claude-opus-5-5",
    stream: true,
    options: {},
    context: {
      systemPrompt: ["system prompt"],
      tools: [{ name: "shell", description: "run", parameters: { type: "object" } }],
      messages,
    },
    ...(override ? { _cacheRetention: override } : {}),
  };
}

type Block = { type?: string; text?: string; cache_control?: { type: string; ttl?: string } };
type Body = {
  cache_control?: { type: string; ttl?: string };
  system?: Block[];
  tools?: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
};

async function build(retention: OcxCacheRetention | undefined, req: OcxParsedRequest, baseUrl = NATIVE): Promise<Body> {
  const built = await adapterFor(retention, baseUrl).buildRequest(req);
  return JSON.parse(built.body) as Body;
}

/** Explicit breakpoints in prompt order as "<where>:<ttl>", where ttl is "1h" or "5m". */
function breakpoints(body: Body): string[] {
  const out: string[] = [];
  const ttl = (b: Block) => b.cache_control?.ttl ?? "5m";
  for (const b of body.tools ?? []) if (b.cache_control) out.push(`tools:${ttl(b)}`);
  for (const b of body.system ?? []) if (b.cache_control) out.push(`system:${ttl(b)}`);
  body.messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!b.cache_control) continue;
      const label = b.type === "tool_result" ? "tool_result" : b.text ?? b.type;
      out.push(`msg${i}(${label}):${ttl(b)}`);
    }
  });
  return out;
}

describe("anthropic hybrid cache retention", () => {
  test("mid-loop: 1h on system and both latest human messages, 5m automatic tail", async () => {
    const body = await build("hybrid", request(MID_LOOP));
    // Tools ride the system prefix, so the freed slot holds the previous human anchor.
    expect(breakpoints(body)).toEqual(["system:1h", "msg0(H1):1h", "msg4(H2):1h"]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  test("turn start: automatic breakpoint matches the 1h anchor on the same final block", async () => {
    const body = await build("hybrid", request(TURN_START));
    expect(breakpoints(body)).toEqual(["system:1h", "msg0(H1):1h", "msg4(H2):1h"]);
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("explicit-only gateway marks the moving tool_result tail with 5m after the 1h anchors", async () => {
    const body = await build("hybrid", request(MID_LOOP), GATEWAY);
    expect(body.cache_control).toBeUndefined();
    expect(breakpoints(body)).toEqual(["system:1h", "msg0(H1):1h", "msg4(H2):1h", "msg6(tool_result):5m"]);
  });

  test("a per-turn override wins over the configured retention", async () => {
    const body = await build("hybrid", request(MID_LOOP, "short"));
    expect(breakpoints(body).every(b => b.endsWith(":5m"))).toBe(true);
    expect(body.cache_control).toEqual({ type: "ephemeral" });

    const none = await build("long", request(MID_LOOP, "none"));
    expect(breakpoints(none)).toEqual([]);
    expect(none.cache_control).toBeUndefined();
  });
});

describe("anthropic uniform cache retention is unchanged", () => {
  test.each([
    ["short", "5m", { type: "ephemeral" }],
    ["long", "1h", { type: "ephemeral", ttl: "1h" }],
  ] as const)("%s keeps tools, system, penultimate user and automatic placement", async (retention, ttl, automatic) => {
    const body = await build(retention, request(MID_LOOP));
    // Penultimate user-role message is H2 (index 4); the last one (tool_result) is left to automatic caching.
    expect(breakpoints(body)).toEqual([`tools:${ttl}`, `system:${ttl}`, `msg4(H2):${ttl}`]);
    expect(body.cache_control).toEqual(automatic);
  });
});

describe("anthropic cache write TTL split", () => {
  test("reports the 1-hour share of the cache write when Anthropic provides it", async () => {
    const events = await adapterFor("hybrid").parseResponse?.(new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
      },
    })));
    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: {
        inputTokens: 140,
        outputTokens: 2,
        cachedInputTokens: 100,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 30,
        cacheCreation1hInputTokens: 20,
      },
    });
  });

  test("a malformed TTL split is dropped without voiding the usage", async () => {
    const events = await adapterFor("hybrid").parseResponse?.(new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: "5" },
      },
    })));
    const done = events?.at(-1) as { usage?: Record<string, unknown> } | undefined;
    expect(done?.usage?.cacheCreationInputTokens).toBe(5);
    expect(done?.usage).not.toHaveProperty("cacheCreation1hInputTokens");
  });
});

describe("anthropic cache keepalive pre-warm", () => {
  test("turns the built request into a zero-output, non-streaming pre-warm", async () => {
    const body = await build("short", { ...request(MID_LOOP), _cacheKeepalivePing: true });
    const raw = body as Body & { max_tokens?: number; stream?: boolean };
    expect(raw.max_tokens).toBe(0);
    expect(raw.stream).toBe(false);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  test("refuses a pre-warm for extended thinking, which Anthropic rejects with max_tokens 0", async () => {
    const thinking: OcxParsedRequest = {
      ...request(MID_LOOP),
      modelId: "claude-haiku-4-5",
      options: { reasoning: "high" },
      _cacheKeepalivePing: true,
    };
    await expect(adapterFor("short").buildRequest(thinking)).rejects.toThrow("cache keepalive");
  });
});
