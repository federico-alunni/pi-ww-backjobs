import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BackgroundJob } from "./types.ts";

const LINGER_MS = 30_000; // Keep finished jobs visible for 30s

export function formatElapsed(startedAt: number, endedAt?: number): string {
  const diffSec = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function renderWidgetLines(
  jobs: BackgroundJob[],
  theme: Theme,
  availableWidth = 80,
): string[] | undefined {
  const now = Date.now();
  // Filter running jobs and recent completed/failed/stopped jobs
  const visible = jobs.filter((j) => {
    if (j.status === "running") return true;
    return j.endedAt && now - j.endedAt < LINGER_MS;
  });

  if (visible.length === 0) {
    return undefined;
  }

  const runningCount = visible.filter((j) => j.status === "running").length;
  const width = Math.max(40, Math.min(availableWidth, 100));

  const border = (char: string, count: number) => char.repeat(Math.max(0, count));

  const titleText = ` ⚡ Backgrounds (${runningCount} active) `;
  const topDashCount = Math.max(2, width - titleText.length - 3);

  const topBorder =
    theme.fg("accent", "╭─") +
    theme.bold(theme.fg("accent", titleText)) +
    theme.fg("dim", border("─", topDashCount)) +
    theme.fg("accent", "╮");

  const lines: string[] = [topBorder];

  for (const job of visible) {
    let icon = "●";
    let iconColor: "success" | "error" | "muted" | "warning" = "success";
    let statusText = "";

    switch (job.status) {
      case "running":
        icon = "●";
        iconColor = "success";
        statusText = formatElapsed(job.startedAt);
        break;
      case "completed":
        icon = "✓";
        iconColor = "success";
        statusText = `completed (${formatElapsed(job.startedAt, job.endedAt)})`;
        break;
      case "failed":
        icon = "✖";
        iconColor = "error";
        statusText = `failed (${job.exitCode ?? 1})`;
        break;
      case "stopped":
        icon = "■";
        iconColor = "muted";
        statusText = "stopped";
        break;
    }

    const dot = theme.fg(iconColor, icon);
    const id = theme.bold(`[${job.id}]`);
    const name = job.name.length > 25 ? `${job.name.slice(0, 23)}…` : job.name;
    const target = job.placement === "tab" ? `tab: ${job.tabLabel}` : `pane: ${job.paneId}`;
    const targetStyled = theme.fg("dim", target);
    const elapsedStyled = theme.fg("dim", statusText);

    lines.push(
      `${theme.fg("accent", "│")} ${dot} ${id} ${name} · ${targetStyled} · ${elapsedStyled}`,
    );
  }

  // Footer hint
  const hintText = theme.fg("dim", "💡 /bg o Ctrl+B per gestire i terminali e aprire tab");
  lines.push(`${theme.fg("accent", "│")} ${hintText}`);

  const bottomBorder =
    theme.fg("accent", "╰") + theme.fg("dim", border("─", width - 2)) + theme.fg("accent", "╯");
  lines.push(bottomBorder);

  return lines;
}
