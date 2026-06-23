/** Shared types — the single home for execution-result and stored-record shapes. */

export interface ExecResult {
  exit: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** true if the command was killed for exceeding its timeout. */
  timedOut: boolean;
  /** per-stream byte-cap truncation: oldest bytes were dropped, the tail kept. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** true EMITTED line count across the whole stream (not just retained bytes). */
  stdoutTotalLines: number;
  stderrTotalLines: number;
  /** true if the stream contained NUL bytes (binary); stdout/stderr is then base64. */
  stdoutBinary: boolean;
  stderrBinary: boolean;
}

export interface RunRecord {
  id: string;
  command: string;
  cwd: string;
  /** wall-clock epoch ms when the run was recorded. Enables ordering + recency
   *  windows in sh_history (id number is NOT a recency order across servers). */
  at: number;
  exit: number;
  durationMs: number;
  timedOut: boolean;
  /** per-stream truncation, mirrored from ExecResult so sh_detail can flag the tail. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** per-stream binary flag; when true the stored stream is base64. */
  stdoutBinary: boolean;
  stderrBinary: boolean;
  /** total attempts made (1 = no retry happened). */
  attempts: number;
  stdout: string;
  stderr: string;
  /** git porcelain diff lines, or null when cwd is not a git repo. */
  filesChanged: string[] | null;
  /** full syscall trace text (feature A), when tracing was requested and captured. */
  trace?: string;
}
