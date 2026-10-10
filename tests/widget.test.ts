import test from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, renderWidgetLines } from "../src/widget.ts";
import type { BackgroundJob } from "../src/types.ts";

const mockTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("formatElapsed formats durations correctly", () => {
  const now = 100000;
  assert.equal(formatElapsed(now - 15000, now), "15s");
  assert.equal(formatElapsed(now - 75000, now), "1m 15s");
  assert.equal(formatElapsed(now - 3665000, now), "1h 1m");
});

test("renderWidgetLines returns undefined when no visible jobs", () => {
  const jobs: BackgroundJob[] = [];
  const lines = renderWidgetLines(jobs, mockTheme);
  assert.equal(lines, undefined);
});

test("renderWidgetLines renders running jobs", () => {
  const jobs: BackgroundJob[] = [
    {
      id: "bg-1",
      name: "npm run dev",
      command: "npm run dev",
      cwd: "/test",
      paneId: "w1:p1",
      tabId: "w1:t1",
      tabLabel: "dev-server",
      placement: "tab",
      status: "running",
      startedAt: Date.now() - 30000,
      statusFile: "/tmp/fake.status",
      scriptFile: "/tmp/fake.sh",
    },
  ];

  const lines = renderWidgetLines(jobs, mockTheme, 80);
  assert.ok(lines && lines.length > 0);
  assert.ok(lines.some((l) => l.includes("⚡ Backgrounds (1 active)")));
  assert.ok(lines.some((l) => l.includes("[bg-1]") && l.includes("npm run dev")));
  assert.ok(lines.some((l) => l.includes("tab: dev-server")));
  assert.ok(lines.some((l) => l.includes("Ctrl+Alt+B or /bg")));
});

test("renderWidgetLines aligns all border lines to the exact width", async () => {
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const jobs: BackgroundJob[] = [
    {
      id: "bg-1",
      name: "test-interrupt",
      command: "sleep 60",
      cwd: "/test",
      paneId: "w6:p25",
      tabId: "w6:t25",
      tabLabel: "test-interrupt",
      placement: "tab",
      status: "running",
      startedAt: Date.now() - 12000,
      statusFile: "/tmp/fake.status",
      scriptFile: "/tmp/fake.sh",
    },
  ];

  const targetWidth = 80;
  const lines = renderWidgetLines(jobs, mockTheme, targetWidth);
  assert.ok(lines && lines.length === 4); // top, job, hint, bottom

  for (const line of lines) {
    assert.equal(visibleWidth(line), targetWidth);
  }
});

