/**
 * pi-ww-backjobs core contract.
 *
 * Pure types: no pi, no Herdr, no runtime code. See DESIGN.md.
 */

// ── Job state ────────────────────────────────────────────────────────────────

export type JobStatus =
  | "starting"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "stopped"
  | "lost";

export type TerminalJobStatus = Extract<JobStatus, "succeeded" | "failed" | "stopped" | "lost">;

export const TERMINAL_STATUSES: readonly TerminalJobStatus[] = [
  "succeeded",
  "failed",
  "stopped",
  "lost",
];

/** Allowed transitions. Anything not listed is a bug. */
export const STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  starting: ["running", "failed"],
  running: ["stopping", "succeeded", "failed", "lost"],
  stopping: ["stopped", "lost"],
  succeeded: [],
  failed: [],
  stopped: [],
  lost: [],
};

/** Read-only snapshot of a job. Safe to serialize. */
export interface JobInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  backend: string;
  status: JobStatus;
  pid?: number;
  exitCode?: number | null;
  /** Signal that ended the process, if any (e.g. "SIGTERM"). */
  signal?: string | null;
  /** Set when the job failed to start or the backend reported an error. */
  error?: string;
  startedAt: number;
  endedAt?: number;
  logFile: string;
  /** Opaque data owned by the caller (e.g. the pi adapter's onExit policy). */
  metadata: Record<string, unknown>;
}

// ── Manager API ──────────────────────────────────────────────────────────────

export interface StartOptions {
  command: string;
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Backend name; defaults to the manager's default backend ("local"). */
  backend?: string;
  metadata?: Record<string, unknown>;
}

export interface ReadOptions {
  /** Byte offset returned by a previous read. Omit to read from the start. */
  cursor?: number;
  /** Return only the last N lines (ignores cursor). */
  tail?: number;
  /** Upper bound of returned bytes. Default 16 KiB. */
  maxBytes?: number;
}

export interface ReadResult {
  text: string;
  /** Pass this back as `cursor` to get only newer output. */
  cursor: number;
  /** True when output was cut to respect maxBytes. */
  truncated: boolean;
  /** True when the job is in a terminal state and everything has been read. */
  eof: boolean;
}

export type WaitUntil = "exit" | { pattern: string | RegExp };

export interface WaitOptions {
  /**
   * "exit" (default) or a pattern. A string pattern is a literal substring,
   * a RegExp is matched as is.
   */
  until?: WaitUntil;
  /** Byte offset where pattern matching starts. Default 0 (whole log). */
  cursor?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type WaitReason = "exit" | "match" | "timeout" | "aborted";

export interface WaitResult {
  reason: WaitReason;
  job: JobInfo;
  /** Matched text when reason is "match". */
  match?: string;
}

export interface StopOptions {
  /** First signal sent to the process group. Default "SIGTERM". */
  signal?: NodeJS.Signals;
  /** Time before escalating to SIGKILL. Default 5000 ms. */
  graceMs?: number;
}

export interface ManagerOptions {
  /** Available backends. The manager never imports a concrete backend. */
  backends: Backend[];
  /** Default "local". */
  defaultBackend?: string;
  /** Directory for log files. Default: a temp dir per manager. */
  logDir?: string;
  /** Finished jobs kept in memory. Default 50. */
  maxFinishedJobs?: number;
}

export interface ProcessManagerApi {
  start(options: StartOptions): Promise<JobInfo>;
  get(id: string): JobInfo | undefined;
  list(filter?: { status?: JobStatus[] }): JobInfo[];
  read(id: string, options?: ReadOptions): Promise<ReadResult>;
  wait(id: string, options?: WaitOptions): Promise<WaitResult>;
  stop(id: string, options?: StopOptions): Promise<JobInfo>;
  /** Remove a finished job and its log file. Throws if the job is not terminal. */
  remove(id: string): Promise<void>;
  on<E extends JobEventType>(type: E, listener: (event: JobEventMap[E]) => void): () => void;
  /** Stop all running jobs and clean up. */
  dispose(): Promise<void>;
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface JobEventMap {
  start: { type: "start"; job: JobInfo };
  status: { type: "status"; job: JobInfo; previous: JobStatus };
  output: { type: "output"; job: JobInfo; chunk: string; cursor: number };
  exit: { type: "exit"; job: JobInfo };
}

export type JobEventType = keyof JobEventMap;
export type JobEvent = JobEventMap[JobEventType];

// ── Backend contract ─────────────────────────────────────────────────────────

export interface BackendStartSpec {
  id: string;
  name: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** The backend MUST append combined stdout + stderr to this file. */
  logFile: string;
}

export interface BackendExit {
  exitCode: number | null;
  signal: string | null;
  /** Set when the backend lost track of the process (→ status "lost"). */
  lost?: boolean;
  error?: string;
}

export interface BackendCallbacks {
  /** Call exactly once when the process is gone. */
  onExit(exit: BackendExit): void;
}

export interface BackendHandle {
  pid?: number;
  /** Send a signal to the whole process group. */
  signal(signal: NodeJS.Signals): Promise<void>;
  /** Release backend resources (watchers, panes, ...). Called after exit. */
  dispose?(): Promise<void>;
}

export interface Backend {
  readonly name: string;
  isAvailable(): boolean | Promise<boolean>;
  /** Spawn the process. Reject if it cannot be started. */
  start(spec: BackendStartSpec, callbacks: BackendCallbacks): Promise<BackendHandle>;
}
