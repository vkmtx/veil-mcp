/**
 * Per-key async mutex — serializes the effect-diff window per repository.
 *
 * Why this exists: the default effect source is a `git status --porcelain` snapshot
 * taken BEFORE a command and again AFTER, diffed into files_changed. Agents fire
 * parallel tool calls, so two sh_run runs can overlap in the SAME repo: run A
 * snapshots before, run B writes files, run A snapshots after — and A's files_changed
 * wrongly absorbs B's writes (cross-attribution). Serializing only the before→run→
 * after sequence per repo makes that window atomic w.r.t. other effect-tracked runs
 * in the same repo, while runs in DIFFERENT repos (different keys) stay concurrent.
 * The trace path is per-process and preview is clone-isolated, so neither needs this.
 */

// Tail of the queue for each key: the Promise that settles when the current holder
// (and everyone ahead of them) is done. A new caller chains onto this tail.
const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively per `key`: concurrent calls with the same key queue and run
 * one at a time (FIFO); calls with different keys run concurrently. `fn`'s result or
 * thrown error propagates to ITS OWN caller — a failing fn never poisons the queue.
 * Never deadlocks: every `fn` settles, and the lock is released in a `finally`.
 */
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Wait for the previous holder to finish, ignoring its outcome — one run's failure
  // must not reject the next run waiting on the same key.
  const run = prev.then(() => fn(), () => fn());
  // Park a never-rejecting marker as the new tail so the next waiter's `.then` above
  // resolves regardless of this run's success/failure.
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    // GC the entry only if no one chained behind us in the meantime — otherwise the
    // newer tail must stay so later callers keep serializing correctly.
    if (tails.get(key) === tail) tails.delete(key);
  }
}
