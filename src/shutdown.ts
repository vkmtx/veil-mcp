/**
 * One-time shutdown coordinator for background processes.
 *
 * Background children are detached and unref'd (see bgregistry), so the server can exit
 * while they run. That is correct for liveness but means we must REAP them on the way
 * out — otherwise stopping the agent would orphan a dev server that keeps holding a
 * port. This installs the reaping hooks once.
 *
 * Primary graceful signal for a stdio MCP server is the transport closing (the agent
 * disconnected); we also cover SIGTERM/SIGINT and stdin EOF. The async drain SIGTERMs
 * every live child, waits briefly for them to exit, SIGKILLs any straggler, then exits.
 * A synchronous best-effort sweep on 'exit' is the last-resort backstop for paths that
 * never ran the async drain.
 *
 * If no background process is ever started, every hook is a near no-op — the normal
 * (no-bg) shutdown path is unaffected.
 */

import { liveHandles, liveCount, killAllLive } from "./bgregistry.js";

let shuttingDown = false;
let installed = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drain: SIGTERM all live children, poll up to ~2s for the registry to empty (children
 * reap themselves on 'close'), SIGKILL any straggler, then exit. Guarded so two signals
 * can't start two competing escalations.
 */
async function drainAndExit(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (liveCount() > 0) {
      killAllLive("SIGTERM");
      // Poll for the registry to drain (each child deletes itself on 'close').
      const deadline = Date.now() + 2000;
      while (liveCount() > 0 && Date.now() < deadline) {
        await sleep(50);
      }
      // Anything still alive ignored SIGTERM — hard-kill the group.
      for (const h of liveHandles()) h.killTree("SIGKILL");
    }
  } finally {
    process.exit(0);
  }
}

/**
 * Install the shutdown hooks once. Pass the MCP transport so its onclose (the agent
 * went away — the primary graceful signal for stdio) triggers the drain; chains any
 * existing onclose so we don't clobber the SDK's own handler.
 */
export function installShutdown(transport?: { onclose?: () => void }): void {
  if (installed) return;
  installed = true;

  process.on("SIGTERM", () => void drainAndExit());
  process.on("SIGINT", () => void drainAndExit());
  // stdin EOF: the parent closed the pipe — for a stdio server the agent is gone.
  process.stdin.on("end", () => void drainAndExit());

  if (transport) {
    const prev = transport.onclose;
    transport.onclose = () => {
      try {
        prev?.();
      } finally {
        void drainAndExit();
      }
    };
  }

  // Last resort: on actual process exit we can't await, so do a synchronous best-effort
  // SIGKILL sweep over whatever is still live. This catches paths that bypassed the
  // async drain (e.g. an unexpected exit), at the cost of no graceful SIGTERM grace.
  process.on("exit", () => {
    // killTree carries the negative-pid→lone-child fallback and swallows ESRCH, so it's
    // the safe way to signal even here; a bare process.kill could throw on a stale pid.
    for (const h of liveHandles()) h.killTree("SIGKILL");
  });
}
