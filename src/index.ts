import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBackgroundCommands } from "./commands.ts";
import { JobManager } from "./job-manager.ts";
import { registerBackgroundTools } from "./tools.ts";
import { renderWidgetLines } from "./widget.ts";

export default function backgroundsExtension(pi: ExtensionAPI): void {
  const manager = new JobManager();
  let latestCtx: ExtensionContext | undefined;

  function updateWidget(): void {
    if (!latestCtx || !latestCtx.hasUI) return;

    const jobs = manager.getAllJobs();
    const hasVisible = jobs.some(
      (j) => j.status === "running" || (j.endedAt && Date.now() - j.endedAt < 30_000),
    );

    if (!hasVisible) {
      try {
        latestCtx.ui.setWidget("ww-backgrounds", undefined);
      } catch {}
      return;
    }

    try {
      latestCtx.ui.setWidget(
        "ww-backgrounds",
        (_tui: any, theme: any) => ({
          invalidate() {},
          render(width: number) {
            return renderWidgetLines(manager.getAllJobs(), theme, width) ?? [];
          },
        }),
        { placement: "aboveEditor" },
      );
    } catch {}
  }

  // Subscribe to job manager updates
  manager.onUpdate(() => {
    updateWidget();
  });

  // Track active ExtensionContext
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    updateWidget();
  });

  pi.on("turn_start", (_event, ctx) => {
    latestCtx = ctx;
    updateWidget();
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", () => {
    if (latestCtx) {
      try {
        latestCtx.ui.setWidget("ww-backgrounds", undefined);
      } catch {}
    }
    manager.dispose();
    latestCtx = undefined;
  });

  // Register Agent Tools
  registerBackgroundTools(pi, manager);

  // Register Slash Commands and Shortcuts
  registerBackgroundCommands(pi, manager);
}
