/**
 * Run-id resolution shared by sh_detail / sh_logs / sh_kill.
 *
 * Why this exists: `id` used to be a REQUIRED string on all three tools, so the common
 * agent call — "show me the output of the thing I just ran" / "stop the dev server I
 * just started" — failed schema validation whenever the id wasn't threaded through, and
 * a stale id answered with a bare `unknown id: cmdN` that named no alternative. Both are
 * dead-end turns. Here the id is optional (defaulting to the obvious run) and a wrong id
 * answers with the ids that ARE addressable.
 *
 * The store is disk-backed and capped, so these lookups are only taken on the
 * omitted-id / unknown-id paths — never on the hot path where the caller passed a good id.
 */

import { liveIds } from "./bgregistry.js";
import { all } from "./store.js";

/** Stored run ids, most recent first — `all()` already orders newest-first by `at`. */
export function recentIds(limit = 8): string[] {
  return all()
    .slice(0, limit)
    .map((r) => r.id);
}

/**
 * Default target for sh_detail: the most recent run of any kind. A live background run
 * has no durable record yet, so fall back to the newest live id.
 */
export function defaultRunId(): string | undefined {
  return recentIds(1)[0] ?? liveIds()[0];
}

/**
 * Default target for sh_logs / sh_kill: the most recently started LIVE background run —
 * the one the agent almost certainly means. With nothing live, fall back to the newest
 * stored record so a poll just after exit still resolves.
 */
export function defaultBackgroundId(): string | undefined {
  return liveIds()[0] ?? recentIds(1)[0];
}

/**
 * Message for an id that resolves to nothing, naming the ids that do. Callers pass the
 * tool's own hint for the empty case (there is nothing useful to suggest when no run
 * exists at all).
 */
export function unknownIdError(id: string, emptyHint: string): string {
  const live = liveIds();
  const recent = recentIds();
  const known = [...new Set([...live, ...recent])];
  if (known.length === 0) return `unknown id: ${id} — ${emptyHint}`;
  const liveNote = live.length ? ` (live: ${live.join(", ")})` : "";
  return `unknown id: ${id} — addressable ids, most recent first: ${known.join(", ")}${liveNote}`;
}

/** Message for a tool called with no id when there is no run to default to. */
export function noRunError(emptyHint: string): string {
  return `no run to address — ${emptyHint}`;
}
