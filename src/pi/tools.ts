import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { isTerminal, type ProcessManager } from "../core/process-manager.ts";
import type { JobInfo, JobLifetime, ReadResult } from "../core/types.ts";
import { describeStatus, formatJobLine, jobDuration } from "./format.ts";
import { DEFAULT_ON_EXIT, ON_EXIT_VALUES, type ExitNotifier, type OnExit } from "./notifier.ts";

const READ_MAX_BYTES = 8000;
const WAIT_DEFAULT_SECONDS = 60;
const WAIT_MAX_SECONDS = 1800;

export interface AdapterState {
  manager(): ProcessManager;
  notifier: ExitNotifier;
  /** Byte offset of the model's last read, per job. */
  cursors: Map<string, number>;
  /** Durable registry of the current session, if any. */
  durableDir(): string | undefined;
  refreshWidget(): void;
}

const LIFETIME_VALUES: readonly JobLifetime[] = ["session", "durable"];

/** String enum as a plain JSON-schema enum (works with every provider). */
function stringEnum<T extends string>(values: readonly T[], description: string): TSchema {
  return Type.Unsafe<T>({ type: "string", enum: [...values], description });
}

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

function outputBlock(read: ReadResult, logFile: string, label: string, isTail = false): string {
  if (!read.text) return `${label}: (none)`;
  const skipped = read.truncated && !isTail ? `\n(older output skipped; full log: ${logFile})` : "";
  return `${label}:${skipped}\n${read.text}`;
}

function onExitHint(onExit: OnExit): string {
  switch (onExit) {
    case "wake":
      return "You will be notified automatically when it exits; do not poll in a loop.";
    case "inform":
      return "A note will be added to the conversation when it exits, without starting a new turn.";
    case "none":
      return "No notification on exit; check it with background_list or background_read.";
  }
}

export function registerTools(pi: ExtensionAPI, state: AdapterState): void {
  /** Read new output since the model's last read and advance its cursor. */
  async function readNew(job: JobInfo, maxBytes = READ_MAX_BYTES): Promise<ReadResult> {
    const result = await state.manager().read(job.id, { cursor: state.cursors.get(job.id) ?? 0, maxBytes });
    state.cursors.set(job.id, result.cursor);
    return result;
  }

  function requireJob(id: string): JobInfo {
    const job = state.manager().get(id);
    if (!job) throw new Error(`Background job "${id}" not found. Use background_list to see jobs.`);
    return job;
  }

  pi.registerTool({
    name: "background_run",
    label: "Background run",
    description:
      "Start a shell command as a background job and return immediately. Use it for long-running or " +
      "persistent work: dev servers, watchers, long builds or test suites, containers. " +
      "Output goes to a log file; the user sees the job in a widget. " +
      "By default (onExit: wake) you are notified when the job exits, so do not poll. " +
      "With lifetime: 'durable' the job survives /reload and pi exiting, and is found again when this session resumes.",
    promptSnippet: "Run commands that never exit or take minutes (servers, watchers, long builds) as background jobs",
    promptGuidelines: [
      "Use background_run for commands that do not exit on their own (dev servers, watchers, `docker compose up`, `tail -f`), with onExit: 'inform'.",
      "Use background_run for commands that may take minutes (full builds, full test suites, dependency installs, image builds); keep using bash for quick commands.",
      "Never start background processes from bash: no trailing `&`, `nohup`, `disown`, `setsid` or `screen`/`tmux` sessions.",
      "After background_run, wait with background_wait (use a pattern such as 'ready|listening' for servers) instead of sleep loops or repeated background_read calls.",
      "With onExit: 'wake' (default) you are notified when the job ends: do not poll it, continue with other work or end your turn.",
      "Use lifetime: 'durable' for jobs that must not be interrupted by a /reload or restart; a durable job reported 'lost' may or may not have completed: verify its effect before running it again, never re-run it blindly.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command (run with bash -c)" }),
      name: Type.Optional(Type.String({ description: "Short label, e.g. 'dev-server'" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
      onExit: Type.Optional(
        stringEnum(
          ON_EXIT_VALUES,
          "When the job exits: 'wake' (default) notifies you and starts a turn if idle; " +
            "'inform' adds a note without starting a turn; 'none' sends nothing. " +
            "Use 'inform' for services expected to run until stopped.",
        ),
      ),
      lifetime: Type.Optional(
        stringEnum(
          LIFETIME_VALUES,
          "'session' (default): stopped when the session ends or reloads. " +
            "'durable': keeps running after /reload or pi exiting; when this session resumes it is reattached " +
            "(running, or finished with its real exit code) and never restarted.",
        ),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const onExit = (params.onExit as OnExit | undefined) ?? DEFAULT_ON_EXIT;
      const cwd = params.cwd ? (isAbsolute(params.cwd) ? params.cwd : resolve(ctx.cwd, params.cwd)) : ctx.cwd;
      const lifetime = (params.lifetime as JobLifetime | undefined) ?? "session";
      if (lifetime === "durable" && !state.durableDir()) {
        throw new Error("Durable jobs are not available: no pi session id (lifetime: 'session' still works).");
      }
      const job = await state.manager().start({
        command: params.command,
        name: params.name,
        cwd,
        lifetime,
        metadata: { onExit },
      });
      if (job.status === "failed") {
        state.notifier.markReported(job.id);
        throw new Error(`Background job [${job.id}] failed to start: ${job.error ?? "unknown error"}`);
      }
      return {
        content: text(
          `Started ${lifetime === "durable" ? "durable " : ""}background job [${job.id}] "${job.name}" (pid ${job.pid}) in ${job.cwd}.\n` +
            `Log: ${job.logFile}\n${onExitHint(onExit)}` +
            (lifetime === "durable" ? "\nIt keeps running after /reload or pi exiting and is reattached when this session resumes." : ""),
        ),
        details: { job },
      };
    },
  });

  pi.registerTool({
    name: "background_list",
    label: "Background list",
    description: "List background jobs (running and recently finished) with status, duration and command.",
    parameters: Type.Object({}),
    async execute() {
      const jobs = state.manager().list();
      if (jobs.length === 0) return { content: text("No background jobs."), details: { jobs } };
      return { content: text(jobs.map((j) => formatJobLine(j)).join("\n")), details: { jobs } };
    },
  });

  pi.registerTool({
    name: "background_read",
    label: "Background read",
    description:
      "Read the output of a background job. By default returns only output produced since your last " +
      "read of that job. Pass `tail` to get the last N lines instead.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id, e.g. 'bg-1'" }),
      tail: Type.Optional(Type.Integer({ minimum: 1, description: "Return the last N lines instead of new output" })),
    }),
    async execute(_callId, params) {
      const job = requireJob(params.id);
      let read: ReadResult;
      if (params.tail !== undefined) {
        read = await state.manager().read(job.id, { tail: params.tail, maxBytes: READ_MAX_BYTES });
        state.cursors.set(job.id, read.cursor);
      } else {
        read = await readNew(job);
      }
      const current = state.manager().get(job.id) ?? job;
      if (isTerminal(current.status)) state.notifier.markReported(job.id);
      const label = params.tail !== undefined ? `Last ${params.tail} lines` : "New output";
      return {
        content: text(
          `[${current.id}] "${current.name}" — ${describeStatus(current)}, ${jobDuration(current)}\n` +
            outputBlock(read, current.logFile, label, params.tail !== undefined),
        ),
        details: { job: current, cursor: read.cursor, truncated: read.truncated },
      };
    },
  });

  pi.registerTool({
    name: "background_wait",
    label: "Background wait",
    description:
      "Wait until a background job exits, or until its output matches a regex (e.g. 'ready|listening on'), " +
      "or until a timeout. Only output you have not read yet is matched. Returns the new output.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id, e.g. 'bg-1'" }),
      pattern: Type.Optional(Type.String({ description: "JavaScript regex to wait for in the output" })),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: WAIT_MAX_SECONDS,
          description: `Maximum wait in seconds (default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS})`,
        }),
      ),
    }),
    async execute(_callId, params, signal) {
      const job = requireJob(params.id);
      let pattern: RegExp | undefined;
      if (params.pattern) {
        try {
          pattern = new RegExp(params.pattern);
        } catch (err: any) {
          throw new Error(`Invalid regex "${params.pattern}": ${err.message}`);
        }
      }
      const timeoutSeconds = Math.min(params.timeoutSeconds ?? WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS);
      const result = await state.manager().wait(job.id, {
        until: pattern ? { pattern } : "exit",
        cursor: state.cursors.get(job.id) ?? 0,
        timeoutMs: timeoutSeconds * 1000,
        signal,
      });
      if (result.reason === "exit") state.notifier.markReported(job.id);

      const current = result.job;
      let headline: string;
      switch (result.reason) {
        case "match":
          headline = `Pattern matched: "${result.match}". Job [${current.id}] is ${current.status}.`;
          break;
        case "exit":
          headline = `Job [${current.id}] ${describeStatus(current)} after ${jobDuration(current)}.`;
          break;
        case "timeout":
          headline = `Timed out after ${timeoutSeconds}s. Job [${current.id}] is still ${current.status}.`;
          break;
        case "aborted":
          headline = `Wait aborted. Job [${current.id}] is ${current.status}.`;
          break;
      }
      const read = await readNew(current);
      return {
        content: text(`${headline}\n${outputBlock(read, current.logFile, "New output")}`),
        details: { job: current, reason: result.reason, match: result.match },
      };
    },
  });

  pi.registerTool({
    name: "background_stop",
    label: "Background stop",
    description:
      "Stop a background job: SIGTERM to its whole process group, then SIGKILL after a grace period. " +
      "Returns once the process is gone.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id, e.g. 'bg-1'" }),
    }),
    async execute(_callId, params) {
      const job = requireJob(params.id);
      const wasRunning = !isTerminal(job.status);
      const stopped = await state.manager().stop(job.id);
      state.notifier.markReported(job.id);
      const prefix = wasRunning ? "Stopped" : "Already finished:";
      return {
        content: text(`${prefix} [${stopped.id}] "${stopped.name}" — ${describeStatus(stopped)} after ${jobDuration(stopped)}.`),
        details: { job: stopped },
      };
    },
  });
}
