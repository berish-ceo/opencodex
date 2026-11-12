/**
 * LOCAL PATCH (reasoning-envelope-store): durable home for large `ocxr1` envelopes.
 *
 * Codex adds an estimate of every earlier reasoning item to the provider's reported usage:
 * `len * 3 / 4 - 650` bytes of its `encrypted_content` (codex-rs context_manager/history.rs),
 * and every turn starts without `x-reasoning-included`. A Claude thinking signature makes one
 * envelope 5-15k chars, so long Claude threads auto-compacted 300k+ tokens before the real
 * context was full. The Responses bridge therefore hands the client a short reference and keeps
 * the exact envelope here; `decodeReasoningEnvelope` swaps it back, so the replayed request (and
 * the prompt-cache prefix) stays byte-identical. A missing row decodes like any unreadable
 * envelope: replay drops that thinking block, and Anthropic accepts the tool loop without it.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";

const FILE_NAME = "reasoning-envelopes.sqlite";
const DAY_MS = 86_400_000;
/** Codex can resume any thread later, so rows never expire by age; only this cap evicts. */
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let db: Database | null | undefined;
let nextPruneAt = 0;
let maxBytes = MAX_BYTES;
let warnedMiss = false;

function open(): Database | null {
  if (db !== undefined) return db;
  let conn: Database | undefined;
  try {
    const dir = getConfigDir();
    assertNotRealHomeUnderTest(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, FILE_NAME);
    for (const suffix of ["", "-wal", "-shm"]) recordOwnedConfigPath(dir, file + suffix);
    conn = new Database(file, { create: true });
    if (process.platform !== "win32") chmodSync(file, 0o600);
    conn.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 1000;"
      + " CREATE TABLE IF NOT EXISTS envelopes (id TEXT PRIMARY KEY, used INTEGER NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL);"
      + " CREATE INDEX IF NOT EXISTS envelopes_lru ON envelopes (used, bytes)");
    db = conn;
  } catch {
    try { conn?.close(); } catch { /* never opened */ }
    db = null; // Unavailable store: envelopes stay inline, exactly as without this patch.
  }
  return db;
}

function prune(conn: Database, now: number): void {
  nextPruneAt = now + 3_600_000;
  // Least recently replayed first, so the open tool loop's newest rows are the last to go.
  conn.query("DELETE FROM envelopes WHERE rowid IN (SELECT rowid FROM (SELECT rowid,"
    + " sum(bytes) OVER (ORDER BY used DESC ROWS UNBOUNDED PRECEDING) AS kept FROM envelopes) WHERE kept > ?)").run(maxBytes);
}

/** One line per process: a lost store would otherwise log every replayed item on every turn. */
function missing(): undefined {
  if (!warnedMiss) console.warn(`[opencodex] a replayed reasoning reference is missing from ${FILE_NAME}; Claude continues without that turn's hidden thinking`);
  warnedMiss = true;
  return undefined;
}

/** Keep an encoded envelope and return its id, or undefined when the store is unavailable. */
export function storeReasoningEnvelope(encoded: string): string | undefined {
  const conn = open();
  if (!conn) return undefined;
  try {
    const id = createHash("sha256").update(encoded).digest("base64url");
    const now = Date.now();
    conn.query("INSERT INTO envelopes VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET used = excluded.used")
      .run(id, now, encoded.length, encoded);
    if (now >= nextPruneAt) prune(conn, now);
    return id;
  } catch {
    return undefined;
  }
}

/** The envelope kept under `id`, or undefined. Refreshes its last use at most once a day. */
export function loadReasoningEnvelope(id: string): string | undefined {
  if (!ID_PATTERN.test(id)) return undefined;
  const conn = open();
  if (!conn) return missing();
  try {
    const row = conn.query<{ used: number; body: string }, [string]>("SELECT used, body FROM envelopes WHERE id = ?").get(id);
    if (!row) return missing();
    const now = Date.now();
    if (now - row.used > DAY_MS) conn.query("UPDATE envelopes SET used = ? WHERE id = ?").run(now, id);
    return row.body;
  } catch {
    return missing();
  }
}

export function resetReasoningEnvelopeStoreForTests(limitBytes = MAX_BYTES): void {
  try { db?.close(); } catch { /* already closed */ }
  db = undefined;
  nextPruneAt = 0;
  maxBytes = limitBytes;
  warnedMiss = false;
}
