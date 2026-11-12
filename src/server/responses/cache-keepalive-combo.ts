/**
 * Prompt-cache keepalive for combos that declare `cacheKeepalive`.
 *
 * After a successful child call the thread is armed with a refresh that replays that exact child
 * request (same body, headers and replay snapshot) through the ordinary Responses pipeline as an
 * internal turn. The pipeline supplies a fresh credential, pacing, account routing and error
 * mapping; the Anthropic adapter turns it into a zero-output pre-warm, and the delivery layer
 * keeps it out of the continuation cache. Each refresh writes its own usage row marked
 * `cacheKeepalive`, because no HTTP ingress owns this request.
 */
import type { NormalizedComboConfig } from "../../combos/types";
import type { OcxConfig } from "../../types";
import { createInferenceSendBudget } from "../inference/context";
import { tryAdmitTurn } from "../lifecycle";
import { addFinalRequestLog, nextRequestLogId, type RequestLogContext } from "../request-log";
import { armCacheKeepalive, type CacheKeepaliveRefreshOutcome } from "./cache-keepalive";
import type { HandleResponsesOptions, ResponsesDispatchers } from "./core-options";

export interface ComboCacheKeepaliveArgs {
  combo: NormalizedComboConfig;
  requestedModel: string;
  target: { provider: string; model: string };
  url: string;
  childHeaders: Headers;
  childBody: Record<string, unknown>;
  comboReplaySnapshot: HandleResponsesOptions["comboReplaySnapshot"];
  options: HandleResponsesOptions;
  config: OcxConfig;
  /** Start time of the real child call; the keepalive window is anchored here. */
  startedAt: number;
  childLog: RequestLogContext;
  conversationId?: string;
  handleResponses: ResponsesDispatchers["handleResponses"];
}

/** Input size of the call that armed the thread: reported usage first, then the build estimate. */
function contextTokensOf(log: RequestLogContext): number | undefined {
  return log.usage?.inputTokens ?? log.usageLogInputTokens;
}

/** Arm the thread's keepalive after a successful child call; a no-op unless the combo opts in. */
export function armComboCacheKeepalive(args: ComboCacheKeepaliveArgs): void {
  const keepalive = args.combo.cacheKeepalive;
  if (!keepalive || args.combo.cacheRetention === "long" || args.combo.cacheRetention === "none") return;
  // The OWN thread id: parallel sub-agents share their parent's id, and each needs its own timer.
  const threadId = args.childHeaders.get("thread-id")?.trim();
  if (!threadId) return;
  const pingBody = JSON.stringify({ ...args.childBody, stream: false });
  const pingHeaders = new Headers(args.childHeaders);
  armCacheKeepalive(threadId, {
    plan: {
      intervalMs: keepalive.intervalSec * 1000,
      maxIdleMs: keepalive.maxIdleMin * 60_000,
      minContextTokens: keepalive.minContextTokens,
    },
    lastCallAt: args.startedAt,
    contextTokens: () => contextTokensOf(args.childLog),
    refresh: () => sendKeepaliveRefresh(args, pingBody, pingHeaders),
  });
}

async function sendKeepaliveRefresh(
  args: ComboCacheKeepaliveArgs,
  pingBody: string,
  pingHeaders: Headers,
): Promise<CacheKeepaliveRefreshOutcome> {
  // Draining or saturated: skip, and let the entry end rather than queue behind real turns.
  const lease = tryAdmitTurn();
  if (!lease) return { ok: false };
  const start = Date.now();
  const request = new Request(args.url, { method: "POST", headers: new Headers(pingHeaders), body: pingBody });
  const log: RequestLogContext = {
    model: args.target.model,
    provider: args.target.provider,
    inboundProtocol: "responses",
    requestedModel: args.requestedModel,
    cacheKeepalive: true,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  };
  let status = 502;
  try {
    const response = await args.handleResponses(request, args.config, log, {
      ...(args.options.admission ? { admission: args.options.admission } : {}),
      ...(args.options.codexAuthPolicy ? { codexAuthPolicy: args.options.codexAuthPolicy } : {}),
      // Explicit nulls: handleResponses captures caller credentials only when these are undefined.
      callerDirectAuth: null,
      openAiSidecarAuth: null,
      nativeCallerAuth: null,
      sendBudget: createInferenceSendBudget(request, log),
      turnAdmissionLease: lease,
      // A concrete target: no combo selection, shadow, or memory rerouting may touch the replay.
      comboAttempt: true,
      ...(args.combo.cacheRetention ? { comboCacheRetention: args.combo.cacheRetention } : {}),
      ...(args.comboReplaySnapshot ? { comboReplaySnapshot: args.comboReplaySnapshot } : {}),
      cacheKeepalivePing: true,
    });
    status = response.status;
    await response.arrayBuffer().catch(() => undefined);
    return { ok: response.ok, cacheWriteTokens: log.usage?.cacheCreationInputTokens };
  } catch {
    return { ok: false };
  } finally {
    lease.release();
    addFinalRequestLog(nextRequestLogId(), start, log, status, { closeReason: "non_stream" });
  }
}
