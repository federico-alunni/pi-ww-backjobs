import type { JobInfo } from "../core/types.ts";
import { formatExitMessage } from "./format.ts";

export type OnExit = "wake" | "inform" | "none";
export const ON_EXIT_VALUES: readonly OnExit[] = ["wake", "inform", "none"];
export const DEFAULT_ON_EXIT: OnExit = "wake";
export const EXIT_MESSAGE_TYPE = "ww-backgrounds:exit";
const TAIL_LINES = 15;
const TAIL_BYTES = 2000;

export interface ExitMessage {
  customType: string;
  content: string;
  display: boolean;
  details: { job: JobInfo; onExit: OnExit };
}

export interface SendOptions {
  triggerTurn: boolean;
  deliverAs?: "followUp";
}

export interface NotifierDeps {
  send(message: ExitMessage, options: SendOptions): void;
  readTail(id: string, lines: number, maxBytes: number): Promise<string>;
}

export function resolveOnExit(job: JobInfo): OnExit {
  const value = job.metadata.onExit;
  return ON_EXIT_VALUES.includes(value as OnExit) ? (value as OnExit) : DEFAULT_ON_EXIT;
}

/**
 * Tells the model that a job ended, according to the job's `onExit` policy.
 *
 * The message is skipped when the model already learned the outcome from a
 * tool result (background_wait, background_stop, ...). The decision is taken
 * on the next macrotask, after those tool calls had a chance to mark it.
 */
export class ExitNotifier {
  private readonly reported = new Set<string>();
  private readonly stoppedByUser = new Set<string>();
  private enabled = true;
  private readonly deps: NotifierDeps;

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  /** The model already knows how the job ended. */
  markReported(id: string): void {
    this.reported.add(id);
  }

  /** The user stopped the job: inform the model, never wake it. */
  markStoppedByUser(id: string): void {
    this.stoppedByUser.add(id);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  reset(): void {
    this.reported.clear();
    this.stoppedByUser.clear();
  }

  handleExit(job: JobInfo): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        void this.deliver(job).finally(resolve);
      }, 0);
    });
  }

  private async deliver(job: JobInfo): Promise<void> {
    const alreadyReported = this.reported.has(job.id);
    const byUser = this.stoppedByUser.has(job.id);
    this.reported.delete(job.id);
    this.stoppedByUser.delete(job.id);
    if (!this.enabled || alreadyReported) return;

    let policy = resolveOnExit(job);
    if (policy === "none") return;
    if (byUser && policy === "wake") policy = "inform";

    let tail = "";
    try {
      tail = await this.deps.readTail(job.id, TAIL_LINES, TAIL_BYTES);
    } catch {}

    this.deps.send(
      {
        customType: EXIT_MESSAGE_TYPE,
        content: formatExitMessage(job, tail),
        display: true,
        details: { job, onExit: policy },
      },
      policy === "wake" ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
    );
  }
}
