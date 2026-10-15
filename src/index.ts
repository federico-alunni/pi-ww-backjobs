import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LocalBackend } from "./backends/local.ts";
import { ProcessManager } from "./core/process-manager.ts";
import { API_CHANNEL, REQUEST_API_CHANNEL, createApi, forwardEvents } from "./pi/bridge.ts";
import { registerCommands } from "./pi/commands.ts";
import { registerMessageRenderer } from "./pi/message-renderer.ts";
import { ExitNotifier } from "./pi/notifier.ts";
import { registerTools, type AdapterState } from "./pi/tools.ts";
import { sessionStateDir, stateRoot } from "./pi/durable-state.ts";
import { WidgetController } from "./pi/widget.ts";

export type { BackjobsApi } from "./pi/bridge.ts";
export { API_CHANNEL, EVENT_CHANNEL, REQUEST_API_CHANNEL } from "./pi/bridge.ts";

export default function backjobsExtension(pi: ExtensionAPI): void {
  let current: ProcessManager | undefined;
  let unwire: (() => void) | undefined;
  /** Durable registry of the current pi session (set at session_start). */
  let durableDir: string | undefined;
  /** durableDir the current manager was created with. */
  let currentDir: string | undefined;

  const notifier = new ExitNotifier({
    send: (message, options) => pi.sendMessage(message, options),
    readTail: async (id, lines, maxBytes) => (await manager().read(id, { tail: lines, maxBytes })).text,
  });
  const widget = new WidgetController(() => current?.list() ?? []);

  /** The manager is created lazily: no processes, timers or files at load time. */
  function manager(): ProcessManager {
    if (current) return current;
    const created = new ProcessManager({ backends: [new LocalBackend()], durableDir });
    const offs = [
      forwardEvents(created, pi.events),
      created.on("start", () => widget.refresh()),
      created.on("status", () => widget.refresh()),
      created.on("exit", (event) => {
        widget.refresh();
        void notifier.handleExit(event.job);
      }),
    ];
    unwire = () => offs.forEach((off) => off());
    current = created;
    currentDir = durableDir;
    return created;
  }

  const state: AdapterState = {
    manager,
    notifier,
    cursors: new Map(),
    durableDir: () => durableDir,
    refreshWidget: () => widget.refresh(),
  };
  const api = createApi(manager);
  const publishApi = () => pi.events.emit(API_CHANNEL, api);

  registerTools(pi, state);
  registerCommands(pi, state);
  registerMessageRenderer(pi);
  pi.events.on(REQUEST_API_CHANNEL, publishApi);
  publishApi();

  pi.on("session_start", (_event, ctx) => {
    let sessionId: string | undefined;
    try {
      sessionId = ctx.sessionManager?.getSessionId();
    } catch {}
    durableDir = sessionId ? sessionStateDir(stateRoot(), sessionId) : undefined;
    // A manager created before session_start (e.g. by another extension through
    // the API) does not know the session's durable directory: replace it while
    // it is still empty.
    if (current && currentDir !== durableDir && current.list().length === 0) {
      const stale = current;
      unwire?.();
      unwire = undefined;
      current = undefined;
      void stale.dispose();
    }
    notifier.setEnabled(true);
    widget.attach(ctx);
    publishApi();
    // Durable jobs of this session, started before a /reload or a restart.
    // Jobs that ended meanwhile are notified now (once), according to onExit.
    if (durableDir && existsSync(durableDir)) {
      manager()
        .reattach()
        .then(() => widget.refresh())
        .catch((err) => console.error("pi-ww-backjobs: reattach failed:", err));
    }
  });

  pi.on("session_shutdown", async () => {
    // Session jobs are stopped, durable ones keep running: do not notify a
    // session that is going away.
    notifier.setEnabled(false);
    widget.detach();
    const disposing = current;
    unwire?.();
    unwire = undefined;
    current = undefined;
    state.cursors.clear();
    notifier.reset();
    await disposing?.dispose();
  });
}
