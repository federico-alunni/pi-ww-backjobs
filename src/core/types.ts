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

/**
 * - `session` (default): the job belongs to the manager; `dispose()` and the
 *   host process exit stop it.
 * - `durable`: the job outlives the manager and the host process. It is kept
 *   in an on-disk registry and reattached by a later manager (`reattach()`).
 */
export type JobLifetime = "session" | "durable";

/** Read-only snapshot of a job. Safe to serialize. */
export interface JobInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  backend: string;
  lifetime: JobLifetime;
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
  /** Default "session". "durable" requires `ManagerOptions.durableDir`. */
  lifetime?: JobLifetime;
  /** Stored in the durable registry: keep it JSON-serializable. */
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
  /** Finished session jobs kept in memory. Default 50. Durable jobs are never pruned. */
  maxFinishedJobs?: number;
  /**
   * Directory of the durable registry (records, logs, exit files) owned by
   * this manager. Required for durable jobs. Never removed by `dispose()`.
   */
  durableDir?: string;
}

export interface ProcessManagerApi {
  start(options: StartOptions): Promise<JobInfo>;
  get(id: string): JobInfo | undefined;
  list(filter?: { status?: JobStatus[] }): JobInfo[];
  read(id: string, options?: ReadOptions): Promise<ReadResult>;
  wait(id: string, options?: WaitOptions): Promise<WaitResult>;
  stop(id: string, options?: StopOptions): Promise<JobInfo>;
  /** Remove a finished job and its files. Throws if the job is not terminal. */
  remove(id: string): Promise<void>;
  /** Remove every finished job (session and durable). Returns the removed ids. */
  removeFinished(): Promise<string[]>;
  /**
   * Load the durable registry and follow its jobs again. A job whose process
   * ended while nobody was watching emits `status` + `exit` now (once: the
   * terminal state is persisted before the events). A job whose process is
   * gone without an exit file ends as `lost`. Jobs are never restarted.
   */
  reattach(): Promise<JobInfo[]>;
  on<E extends JobEventType>(type: E, listener: (event: JobEventMap[E]) => void): () => void;
  /** Stop session jobs, detach durable ones (left running) and clean up. */
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
  /**
   * Set for durable jobs: the process must survive the host process, and its
   * exit status must be written to `exitFile` (see `reattach`).
   */
  durable?: { exitFile: string };
}

export interface BackendReattachSpec {
  id: string;
  pid?: number;
  /** Identity token returned by `start()` (`BackendHandle.processStart`). */
  processStart?: string;
  exitFile: string;
  logFile: string;
}

export type BackendReattachResult = { handle: BackendHandle } | { exit: BackendExit };

export interface BackendExit {
  exitCode: number | null;
  signal: string | null;
  /** Set when the backend lost track of the process (→ status "lost"). */
  lost?: boolean;
  error?: string;
  /** When the process ended, if known and earlier than now (e.g. ended while unwatched). */
  endedAt?: number;
}

export interface BackendCallbacks {
  /** Call exactly once when the process is gone. */
  onExit(exit: BackendExit): void;
}

export interface BackendHandle {
  pid?: number;
  /** Opaque process identity (e.g. start time) to tell a reused pid apart. */
  processStart?: string;
  /** Send a signal to the whole process group. */
  signal(signal: NodeJS.Signals): Promise<void>;
  /** Release backend resources (watchers, panes, ...). Called after exit. */
  dispose?(): Promise<void>;
  /** Stop watching a durable process without touching it (manager disposed). */
  detach?(): void;
}

export interface Backend {
  readonly name: string;
  isAvailable(): boolean | Promise<boolean>;
  /** Spawn the process. Reject if it cannot be started. */
  start(spec: BackendStartSpec, callbacks: BackendCallbacks): Promise<BackendHandle>;
  /**
   * Durable jobs only: find a process started by an earlier host process.
   * Returns its exit when it is over (exit file, or `lost`), a handle when it
   * is still running. Backends without it cannot run durable jobs.
   */
  reattach?(spec: BackendReattachSpec, callbacks: BackendCallbacks): Promise<BackendReattachResult>;
}
