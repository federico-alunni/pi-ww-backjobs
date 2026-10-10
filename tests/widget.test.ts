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
  assert.ok(lines.some((l) => l.includes("/bg o Ctrl+B")));
});

test("renderWidgetLines excludes old completed jobs after linger period", () => {
  const oldJob: BackgroundJob = {
    id: "bg-old",
    name: "old task",
    command: "echo old",
    cwd: "/test",
    paneId: "w1:p1",
    tabId: "w1:t1",
    tabLabel: "old",
    placement: "tab",
    status: "completed",
    startedAt: Date.now() - 60000,
    endedAt: Date.now() - 40000, // 40s ago > 30s linger
    statusFile: "/tmp/fake.status",
    scriptFile: "/tmp/fake.sh",
  };

  const lines = renderWidgetLines([oldJob], mockTheme, 80);
  assert.equal(lines, undefined);
});
