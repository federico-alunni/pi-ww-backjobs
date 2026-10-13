import type { ProcessManager } from "../core/process-manager.ts";
import type {
  JobEvent,
  JobInfo,
  JobStatus,
  ReadOptions,
  ReadResult,
  StartOptions,
  StopOptions,
  WaitOptions,
  WaitResult,
} from "../core/types.ts";
import type { OnExit } from "./notifier.ts";

/** Every core event, payload `JobEvent` ({ type, job, ... }). */
export const EVENT_CHANNEL = "pi-ww-backjobs:event";
/** Payload: `BackjobsApi`. Emitted at load, at session start and on request. */
export const API_CHANNEL = "pi-ww-backjobs:api";
/** Emit (no payload) to receive the API on `API_CHANNEL`. */
export const REQUEST_API_CHANNEL = "pi-ww-backjobs:request-api";

export interface BackjobsApi {
  readonly version: 1;
  /** `onExit` defaults to "wake", like the background_run tool. */
  start(options: StartOptions & { onExit?: OnExit }): Promise<JobInfo>;
  get(id: string): JobInfo | undefined;
  list(filter?: { status?: JobStatus[] }): JobInfo[];
  read(id: string, options?: ReadOptions): Promise<ReadResult>;
  wait(id: string, options?: WaitOptions): Promise<WaitResult>;
  stop(id: string, options?: StopOptions): Promise<JobInfo>;
  remove(id: string): Promise<void>;
}

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** API bound lazily: always talks to the manager of the current session. */
export function createApi(manager: () => ProcessManager): BackjobsApi {
  return {
    version: 1,
    start: ({ onExit, ...options }) =>
      manager().start({ ...options, metadata: { ...options.metadata, ...(onExit ? { onExit } : {}) } }),
    get: (id) => manager().get(id),
    list: (filter) => manager().list(filter),
    read: (id, options) => manager().read(id, options),
    wait: (id, options) => manager().wait(id, options),
    stop: (id, options) => manager().stop(id, options),
    remove: (id) => manager().remove(id),
  };
}

export function forwardEvents(manager: ProcessManager, events: EventBusLike): () => void {
  const forward = (event: JobEvent) => events.emit(EVENT_CHANNEL, event);
  const offs = (["start", "status", "output", "exit"] as const).map((type) => manager.on(type, forward));
  return () => offs.forEach((off) => off());
}
