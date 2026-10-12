import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LocalBackend } from "./backends/local.ts";
import { ProcessManager } from "./core/process-manager.ts";
import { API_CHANNEL, REQUEST_API_CHANNEL, createApi, forwardEvents } from "./pi/bridge.ts";
import { registerCommands } from "./pi/commands.ts";
import { registerMessageRenderer } from "./pi/message-renderer.ts";
import { ExitNotifier } from "./pi/notifier.ts";
import { registerTools, type AdapterState } from "./pi/tools.ts";
import { WidgetController } from "./pi/widget.ts";

export type { BackgroundsApi } from "./pi/bridge.ts";
export { API_CHANNEL, EVENT_CHANNEL, REQUEST_API_CHANNEL } from "./pi/bridge.ts";

export default function backgroundsExtension(pi: ExtensionAPI): void {
  let current: ProcessManager | undefined;
  let unwire: (() => void) | undefined;

  const notifier = new ExitNotifier({
    send: (message, options) => pi.sendMessage(message, options),
    readTail: async (id, lines, maxBytes) => (await manager().read(id, { tail: lines, maxBytes })).text,
  });
  const widget = new WidgetController(() => current?.list() ?? []);

  /** The manager is created lazily: no processes, timers or files at load time. */
  function manager(): ProcessManager {
    if (current) return current;
    const created = new ProcessManager({ backends: [new LocalBackend()] });
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
    return created;
  }

  const state: AdapterState = { manager, notifier, cursors: new Map() };
  const api = createApi(manager);
  const publishApi = () => pi.events.emit(API_CHANNEL, api);

  registerTools(pi, state);
  registerCommands(pi, state);
  registerMessageRenderer(pi);
  pi.events.on(REQUEST_API_CHANNEL, publishApi);
  publishApi();

  pi.on("session_start", (_event, ctx) => {
    notifier.setEnabled(true);
    widget.attach(ctx);
    publishApi();
  });

  pi.on("session_shutdown", async () => {
    // Jobs are stopped on shutdown: do not notify a session that is going away.
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
