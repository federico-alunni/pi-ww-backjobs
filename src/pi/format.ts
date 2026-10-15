import type { JobInfo, JobStatus } from "../core/types.ts";

export type StatusColor = "success" | "error" | "warning" | "muted" | "accent";

export const STATUS_STYLE: Record<JobStatus, { icon: string; color: StatusColor }> = {
  starting: { icon: "○", color: "accent" },
  running: { icon: "●", color: "success" },
  stopping: { icon: "◌", color: "warning" },
  succeeded: { icon: "✓", color: "success" },
  failed: { icon: "✖", color: "error" },
  stopped: { icon: "■", color: "muted" },
  lost: { icon: "?", color: "warning" },
};

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m ${totalSec % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function jobDuration(job: JobInfo, now = Date.now()): string {
  return formatDuration((job.endedAt ?? now) - job.startedAt);
}

/** "running", "succeeded (exit 0)", "failed (exit 3)", "failed (SIGTERM)", ... */
export function describeStatus(job: JobInfo): string {
  if (job.status === "failed" || job.status === "succeeded") {
    if (job.signal) return `${job.status} (${job.signal})`;
    if (job.exitCode !== undefined && job.exitCode !== null) return `${job.status} (exit ${job.exitCode})`;
  }
  return job.status;
}

/** One-line, plain-text summary for the model. */
export function formatJobLine(job: JobInfo, now = Date.now()): string {
  const pid = job.pid ? ` pid ${job.pid}` : "";
  const durable = job.lifetime === "durable" ? " durable" : "";
  const error = job.error ? ` error: ${job.error}` : "";
  return `[${job.id}] "${job.name}" — ${describeStatus(job)}, ${jobDuration(job, now)}${durable}${pid}${error}\n    $ ${job.command}\n    cwd: ${job.cwd}`;
}

export function lastLines(text: string, count: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(-count).join("\n");
}

/** Text of the message sent to the model when a job ends. */
export function formatExitMessage(job: JobInfo, tail: string): string {
  const kind = job.lifetime === "durable" ? "Durable background job" : "Background job";
  const header = `${kind} [${job.id}] "${job.name}" ${describeStatus(job)} after ${jobDuration(job)}.`;
  const parts = [header, `$ ${job.command}`];
  if (job.error) parts.push(`Error: ${job.error}`);
  if (job.status === "lost" && job.lifetime === "durable") {
    parts.push("Outcome unknown: it was not restarted. Check whether its effect happened before running it again.");
  }
  parts.push(tail.trim() ? `Last output:\n${tail}` : "No output.");
  parts.push(`Full log: ${job.logFile}`);
  return parts.join("\n");
}
