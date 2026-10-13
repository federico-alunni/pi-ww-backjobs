import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  STATUS_TRANSITIONS,
  TERMINAL_STATUSES,
  type Backend,
  type BackendExit,
  type BackendHandle,
  type JobEventMap,
  type JobEventType,
  type JobInfo,
  type JobStatus,
  type ManagerOptions,
  type ProcessManagerApi,
  type ReadOptions,
  type ReadResult,
  type StartOptions,
  type StopOptions,
  type WaitOptions,
  type WaitResult,
} from "./types.ts";

const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_GRACE_MS = 5000;
const KILL_WAIT_MS = 2000;
const OUTPUT_POLL_MS = 250;
/** Rolling text kept per pattern waiter, so long logs do not grow memory. */
const MATCH_WINDOW = 64 * 1024;

interface Waiter {
  pattern?: string | RegExp;
  buffer: string;
  settle(result: WaitResult): void;
}

interface JobRecord {
  info: JobInfo;
  handle?: BackendHandle;
  started: Promise<void>;
  /** Bytes of the log already turned into `output` events. */
  emitted: number;
  decoder: StringDecoder;
  waiters: Set<Waiter>;
}

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly JobStatus[]).includes(status);
}

function snapshot(info: JobInfo): JobInfo {
  return { ...info, metadata: { ...info.metadata } };
}

function readRange(file: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buf = Buffer.alloc(length);
  if (length === 0) return buf;
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function matchPattern(text: string, pattern: string | RegExp): string | undefined {
  if (typeof pattern === "string") return text.includes(pattern) ? pattern : undefined;
  const re = new RegExp(pattern.source, pattern.flags.replace("g", "").replace("y", ""));
  return re.exec(text)?.[0];
}

export class ProcessManager implements ProcessManagerApi {
  private readonly backends = new Map<string, Backend>();
  private readonly defaultBackend: string;
  private readonly maxFinishedJobs: number;
  private readonly ownsLogDir: boolean;
  private logDir?: string;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Map<JobEventType, Set<(event: any) => void>>();
  private counter = 0;
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(options: ManagerOptions) {
    for (const backend of options.backends) this.backends.set(backend.name, backend);
    this.defaultBackend = options.defaultBackend ?? "local";
    this.maxFinishedJobs = options.maxFinishedJobs ?? 50;
    this.logDir = options.logDir;
    this.ownsLogDir = !options.logDir;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  on<E extends JobEventType>(type: E, listener: (event: JobEventMap[E]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit<E extends JobEventType>(type: E, event: JobEventMap[E]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        listener(event);
      } catch (err) {
        console.error(`pi-ww-backjobs: ${type} listener failed:`, err);
      }
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  get(id: string): JobInfo | undefined {
    const record = this.jobs.get(id);
    return record ? snapshot(record.info) : undefined;
  }

  list(filter?: { status?: JobStatus[] }): JobInfo[] {
    return [...this.jobs.values()]
      .map((r) => r.info)
      .filter((info) => !filter?.status || filter.status.includes(info.status))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(snapshot);
  }

  // ── Start ───────────────────────────────────────────────────────────────

  async start(options: StartOptions): Promise<JobInfo> {
    if (this.disposed) throw new Error("ProcessManager is disposed");
    const command = options.command?.trim();
    if (!command) throw new Error("command must not be empty");

    const backendName = options.backend ?? this.defaultBackend;
    const backend = this.backends.get(backendName);
    if (!backend) throw new Error(`Unknown backend "${backendName}"`);
    if (!(await backend.isAvailable())) throw new Error(`Backend "${backendName}" is not available`);

    const cwd = resolve(options.cwd?.trim() || process.cwd());
    if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

    const id = `bg-${++this.counter}`;
    const logFile = join(this.ensureLogDir(), `${id}.log`);
    writeFileSync(logFile, "");

    const info: JobInfo = {
      id,
      name: options.name?.trim() || command.slice(0, 40),
      command,
      cwd,
      backend: backendName,
      status: "starting",
      startedAt: Date.now(),
      logFile,
      metadata: { ...options.metadata },
    };

    let markStarted!: () => void;
    const record: JobRecord = {
      info,
      started: new Promise((r) => (markStarted = r)),
      emitted: 0,
      decoder: new StringDecoder("utf8"),
      waiters: new Set(),
    };
    this.jobs.set(id, record);

    try {
      record.handle = await backend.start(
        { id, name: info.name, command, cwd, env: options.env, logFile },
        { onExit: (exit) => this.handleExit(record, exit) },
      );
      info.pid = record.handle.pid;
      this.emit("start", { type: "start", job: snapshot(info) });
      // The process may already have exited while start() was pending.
      if (info.status === "starting") this.transition(record, "running");
    } catch (err: any) {
      info.error = err?.message ?? String(err);
      this.emit("start", { type: "start", job: snapshot(info) });
      this.finish(record, "failed");
    } finally {
      markStarted();
    }

    this.ensurePolling();
    return snapshot(info);
  }

  // ── Output ──────────────────────────────────────────────────────────────

  async read(id: string, options: ReadOptions = {}): Promise<ReadResult> {
    const record = this.require(id);
    const { logFile } = record.info;
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const size = fileSize(logFile);
    const terminal = isTerminal(record.info.status);

    if (options.tail !== undefined) {
      const start = Math.max(0, size - maxBytes);
      let text = readRange(logFile, start, size).toString("utf8");
      let truncated = start > 0;
      if (truncated) text = text.slice(text.indexOf("\n") + 1);
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (lines.length > options.tail) {
        truncated = true;
        lines.splice(0, lines.length - options.tail);
      }
      return { text: lines.join("\n"), cursor: size, truncated, eof: terminal };
    }

    const cursor = Math.min(Math.max(0, options.cursor ?? 0), size);
    let start = cursor;
    let truncated = false;
    if (size - cursor > maxBytes) {
      start = size - maxBytes;
      truncated = true;
    }
    let text = readRange(logFile, start, size).toString("utf8");
    if (truncated) text = text.slice(text.indexOf("\n") + 1);
    return { text, cursor: size, truncated, eof: terminal };
  }

  // ── Wait ────────────────────────────────────────────────────────────────

  wait(id: string, options: WaitOptions = {}): Promise<WaitResult> {
    const record = this.require(id);
    const until = options.until ?? "exit";
    const pattern = until === "exit" ? undefined : until.pattern;
    // Bring `emitted` up to the current log size before looking back.
    this.pollOutput(record);

    return new Promise<WaitResult>((resolvePromise) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => waiter.settle({ reason: "aborted", job: snapshot(record.info) });

      const waiter: Waiter = {
        pattern,
        buffer: "",
        settle: (result) => {
          if (!record.waiters.delete(waiter)) return;
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolvePromise(result);
        },
      };
      record.waiters.add(waiter);

      if (pattern !== undefined) {
        // Output already in the log (and not yet emitted) counts too.
        const from = Math.min(Math.max(0, options.cursor ?? 0), record.emitted);
        const existing = readRange(record.info.logFile, from, record.emitted).toString("utf8");
        this.feedWaiter(record, waiter, existing);
        if (!record.waiters.has(waiter)) return;
      }

      if (isTerminal(record.info.status)) {
        this.pollOutput(record);
        waiter.settle({ reason: "exit", job: snapshot(record.info) });
        return;
      }
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => waiter.settle({ reason: "timeout", job: snapshot(record.info) }),
          Math.max(0, options.timeoutMs),
        );
      }
    });
  }

  private feedWaiter(record: JobRecord, waiter: Waiter, chunk: string): void {
    if (waiter.pattern === undefined || chunk === "") return;
    waiter.buffer = (waiter.buffer + chunk).slice(-MATCH_WINDOW);
    const match = matchPattern(waiter.buffer, waiter.pattern);
    if (match !== undefined) {
      waiter.settle({ reason: "match", job: snapshot(record.info), match });
    }
  }

  // ── Stop / remove ───────────────────────────────────────────────────────

  async stop(id: string, options: StopOptions = {}): Promise<JobInfo> {
    const record = this.require(id);
    await record.started;
    if (isTerminal(record.info.status)) return snapshot(record.info);

    if (record.info.status === "running") this.transition(record, "stopping");
    const handle = record.handle!;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

    await handle.signal(options.signal ?? "SIGTERM").catch(() => {});
    let result = await this.wait(id, { timeoutMs: graceMs });
    if (result.reason !== "exit") {
      await handle.signal("SIGKILL").catch(() => {});
      result = await this.wait(id, { timeoutMs: KILL_WAIT_MS });
    }
    if (result.reason !== "exit") {
      record.info.error = "Process did not exit after SIGKILL";
      this.finish(record, "lost");
    }
    return snapshot(record.info);
  }

  async remove(id: string): Promise<void> {
    const record = this.require(id);
    if (!isTerminal(record.info.status)) {
      throw new Error(`Job ${id} is ${record.info.status}; stop it before removing it`);
    }
    this.jobs.delete(id);
    try {
      unlinkSync(record.info.logFile);
    } catch {}
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = [...this.jobs.values()].filter((r) => !isTerminal(r.info.status));
    await Promise.all(active.map((r) => this.stop(r.info.id, { graceMs: 1000 }).catch(() => {})));
    this.stopPolling();
    this.listeners.clear();
    if (this.ownsLogDir && this.logDir) {
      try {
        rmSync(this.logDir, { recursive: true, force: true });
      } catch {}
    }
    this.jobs.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private require(id: string): JobRecord {
    const record = this.jobs.get(id);
    if (!record) throw new Error(`Background job "${id}" not found`);
    return record;
  }

  private ensureLogDir(): string {
    if (!this.logDir) this.logDir = mkdtempSync(join(tmpdir(), "pi-ww-backjobs-"));
    return this.logDir;
  }

  private transition(record: JobRecord, next: JobStatus): boolean {
    const previous = record.info.status;
    if (previous === next) return false;
    if (!STATUS_TRANSITIONS[previous].includes(next)) {
      console.error(`pi-ww-backjobs: invalid transition ${previous} → ${next} for ${record.info.id}`);
      return false;
    }
    record.info.status = next;
    this.emit("status", { type: "status", job: snapshot(record.info), previous });
    return true;
  }

  private handleExit(record: JobRecord, exit: BackendExit): void {
    const info = record.info;
    info.exitCode = exit.exitCode;
    info.signal = exit.signal;
    if (exit.error) info.error = exit.error;

    let next: JobStatus;
    if (exit.lost) next = "lost";
    else if (info.status === "stopping") next = "stopped";
    else if (exit.exitCode === 0) next = "succeeded";
    else next = "failed";

    // Exit before start() resolved: go through "running" to keep transitions valid.
    if (info.status === "starting" && next !== "failed") this.transition(record, "running");
    this.finish(record, next);
  }

  private finish(record: JobRecord, status: JobStatus): void {
    if (isTerminal(record.info.status)) return;
    this.pollOutput(record);
    record.info.endedAt = Date.now();
    if (!this.transition(record, status)) return;

    const job = snapshot(record.info);
    for (const waiter of [...record.waiters]) waiter.settle({ reason: "exit", job });
    this.emit("exit", { type: "exit", job });

    const handle = record.handle;
    if (handle?.dispose) void handle.dispose().catch(() => {});
    this.pruneFinished();
  }

  private pruneFinished(): void {
    const finished = [...this.jobs.values()]
      .filter((r) => isTerminal(r.info.status))
      .sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0));
    for (const record of finished.slice(0, Math.max(0, finished.length - this.maxFinishedJobs))) {
      void this.remove(record.info.id);
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => {
      let active = false;
      for (const record of this.jobs.values()) {
        if (isTerminal(record.info.status)) continue;
        active = true;
        this.pollOutput(record);
      }
      if (!active) this.stopPolling();
    }, OUTPUT_POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Turn new log bytes into `output` events and feed pattern waiters. */
  private pollOutput(record: JobRecord): void {
    const size = fileSize(record.info.logFile);
    if (size <= record.emitted) return;
    const chunk = record.decoder.write(readRange(record.info.logFile, record.emitted, size));
    record.emitted = size;
    if (!chunk) return;
    this.emit("output", { type: "output", job: snapshot(record.info), chunk, cursor: size });
    for (const waiter of [...record.waiters]) this.feedWaiter(record, waiter, chunk);
  }
}
