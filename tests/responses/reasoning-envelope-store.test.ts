// LOCAL PATCH (reasoning-envelope-store): large ocxr1 envelopes reach the client as short refs.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { parseRequest } from "../../src/responses/parser";
import { decodeReasoningEnvelope, encodeReasoningEnvelope, externalizeReasoningEnvelope, OCX_REASONING_PREFIX } from "../../src/responses/reasoning-envelope";
import { resetReasoningEnvelopeStoreForTests } from "../../src/responses/reasoning-envelope-store";
import type { AdapterEvent } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const SIGNATURE = `Eq${"A".repeat(12_000)}==`;
const previousHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-envelope-store-"));
  process.env.OPENCODEX_HOME = home;
  resetReasoningEnvelopeStoreForTests();
});

afterEach(() => {
  resetReasoningEnvelopeStoreForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const refTo = (value: unknown) => OCX_REASONING_PREFIX + Buffer.from(JSON.stringify({ ref: value })).toString("base64");

describe("reasoning envelope store", () => {
  test("a large envelope becomes a reference Codex counts as zero and decodes to the same envelope", () => {
    const full = encodeReasoningEnvelope({ sig: SIGNATURE, txt: "hidden", red: ["RED"] });
    const ref = externalizeReasoningEnvelope(full);
    expect(ref.startsWith(OCX_REASONING_PREFIX)).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(866);
    expect(decodeReasoningEnvelope(ref)).toEqual(decodeReasoningEnvelope(full));
    resetReasoningEnvelopeStoreForTests(); // proxy restart
    expect(decodeReasoningEnvelope(ref)?.sig).toBe(SIGNATURE);
  });

  test("a small envelope stays inline", () => {
    const small = encodeReasoningEnvelope({ sig: "RealSig1234567890==" });
    expect(externalizeReasoningEnvelope(small)).toBe(small);
  });

  test("unknown, malformed and nested references decode as unreadable", () => {
    expect(decodeReasoningEnvelope(refTo("A".repeat(43)))).toBeNull();
    expect(decodeReasoningEnvelope(refTo("../x"))).toBeNull();
    expect(decodeReasoningEnvelope(refTo(7))).toBeNull();
    // A row whose body is itself a reference is not followed.
    const inner = externalizeReasoningEnvelope(encodeReasoningEnvelope({ sig: SIGNATURE }));
    const db = new Database(join(home, "reasoning-envelopes.sqlite"));
    db.query("INSERT INTO envelopes VALUES (?, ?, ?, ?)").run("B".repeat(43), Date.now(), inner.length, inner);
    db.close();
    expect(decodeReasoningEnvelope(refTo("B".repeat(43)))).toBeNull();
  });

  test("an unavailable store keeps the envelope inline", () => {
    const file = join(home, "not-a-directory");
    writeFileSync(file, "");
    process.env.OPENCODEX_HOME = join(file, "home");
    resetReasoningEnvelopeStoreForTests();
    const full = encodeReasoningEnvelope({ sig: SIGNATURE });
    expect(externalizeReasoningEnvelope(full)).toBe(full);
  });

  test("rows never expire by age; over the size limit the least recently replayed go first", () => {
    const keep = (tag: string) => externalizeReasoningEnvelope(encodeReasoningEnvelope({ sig: `${SIGNATURE}${tag}` }));
    const idOf = (ref: string) => (JSON.parse(Buffer.from(ref.slice(OCX_REASONING_PREFIX.length), "base64").toString()) as { ref: string }).ref;
    const a = keep("a");
    const b = keep("b");
    const db = new Database(join(home, "reasoning-envelopes.sqlite"));
    db.query("UPDATE envelopes SET used = ? WHERE id = ?").run(Date.now() - 400 * 86_400_000, idOf(a));
    db.query("UPDATE envelopes SET used = ? WHERE id = ?").run(Date.now() - 300 * 86_400_000, idOf(b));
    db.close();
    // Idle for over a year and still replayable; the read marks it as recently used.
    expect(decodeReasoningEnvelope(a)?.sig).toBe(`${SIGNATURE}a`);
    resetReasoningEnvelopeStoreForTests(40_000); // room for two of these rows
    const c = keep("c");
    expect(decodeReasoningEnvelope(b)).toBeNull();
    expect(decodeReasoningEnvelope(a)?.sig).toBe(`${SIGNATURE}a`);
    expect(decodeReasoningEnvelope(c)?.sig).toBe(`${SIGNATURE}c`);
  });

  test("a bridged Claude tool turn replays its exact signature from the short reference", async () => {
    async function* turn(): AsyncGenerator<AdapterEvent> {
      yield { type: "thinking_delta", thinking: "chain" };
      yield { type: "thinking_signature", signature: SIGNATURE };
      yield { type: "tool_call_start", id: "call_1", name: "shell" };
      yield { type: "tool_call_delta", arguments: "{}" };
      yield { type: "tool_call_end" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 2 } };
    }
    const sse = await new Response(bridgeToResponsesSSE(turn(), "claude-x")).text();
    const items = sse.split("\n").filter(line => line.startsWith("data: {"))
      .map(line => JSON.parse(line.slice(6)) as { type?: string; item?: Record<string, unknown> })
      .filter(frame => frame.type === "response.output_item.done").map(frame => frame.item!);
    const reasoning = items.find(item => item.type === "reasoning")!;
    expect((reasoning.encrypted_content as string).length).toBeLessThanOrEqual(866);
    resetReasoningEnvelopeStoreForTests();
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
        reasoning,
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
    });
    const adapter = withTestTranslatorBudget(createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-test" }));
    const body = JSON.parse((await adapter.buildRequest(parsed) as { body: string }).body) as { messages: { content: unknown }[] };
    const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content as { type: string; signature?: string }[] : []);
    expect(blocks.find(block => block.type === "thinking")?.signature).toBe(SIGNATURE);
  });
});
