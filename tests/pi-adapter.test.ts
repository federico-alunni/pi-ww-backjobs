import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension, { API_CHANNEL, EVENT_CHANNEL, REQUEST_API_CHANNEL, type BackgroundsApi } from "../src/index.ts";
import type { JobInfo } from "../src/core/types.ts";
import { renderWidgetLines, statusText, visibleJobs, LINGER_MS } from "../src/pi/widget.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const messages: Array<{ message: any; options: any }> = [];
  const bus = new Map<string, Set<(data: unknown) => void>>();

  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    on: (event: string, handler: Function) => handlers.set(event, handler),
    events: {
      emit: (channel: string, data: unknown) => bus.get(channel)?.forEach((h) => h(data)),
      on: (channel: string, handler: (data: unknown) => void) => {
        if (!bus.has(channel)) bus.set(channel, new Set());
        bus.get(channel)!.add(handler);
        return () => bus.get(channel)!.delete(handler);
      },
    },
  };

  extension(pi);
  const ctx: any = { cwd: process.cwd(), hasUI: false, mode: "print" };
  handlers.get("session_start")!({ type: "session_start" }, ctx);

  async function call(name: string, params: Record<string, unknown>) {
    const result = await tools.get(name).execute("call-1", params, undefined, undefined, ctx);
    return { text: result.content[0].text as string, details: result.details };
  }

  return {
    pi,
    tools,
    commands,
    messages,
    call,
    shutdown: () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
  };
}

let current: ReturnType<typeof createHarness> | undefined;
function harness() {
  current = createHarness();
  return current;
}
afterEach(async () => {
  await current?.shutdown();
  current = undefined;
});

test("registers tools and /bg", () => {
  const h = harness();
  assert.deepEqual(
    [...h.tools.keys()].sort(),
    ["background_list", "background_read", "background_run", "background_stop", "background_wait"],
  );
  for (const tool of h.tools.values()) assert.ok(tool.label, `${tool.name} has a label`);
  assert.ok(h.commands.has("bg"));
});

test("onExit default (wake): exit message with triggerTurn and output tail", async () => {
  const h = harness();
  const run = await h.call("background_run", { command: "echo built; exit 2", name: "build" });
  assert.match(run.text, /Started background job \[bg-1\] "build"/);
  assert.match(run.text, /notified automatically/);

  await sleep(600);
  assert.equal(h.messages.length, 1);
  const { message, options } = h.messages[0]!;
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(message.customType, "ww-backgrounds:exit");
  assert.match(message.content, /\[bg-1\] "build" failed \(exit 2\)/);
  assert.match(message.content, /built/);
});

test("onExit inform → no turn; none → no message", async () => {
  const h = harness();
  await h.call("background_run", { command: "true", onExit: "inform" });
  await h.call("background_run", { command: "true", onExit: "none" });
  await sleep(600);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0]!.options, { triggerTurn: false });
});

test("no duplicate notification when background_wait already reported the exit", async () => {
  const h = harness();
  await h.call("background_run", { command: "sleep 0.2; echo done" });
  const wait = await h.call("background_wait", { id: "bg-1", timeoutSeconds: 5 });
  assert.match(wait.text, /Job \[bg-1\] succeeded \(exit 0\)/);
  assert.match(wait.text, /done/);
  await sleep(300);
  assert.equal(h.messages.length, 0);
});

test("background_read returns only new output; wait matches a pattern", async () => {
  const h = harness();
  await h.call("background_run", {
    command: "echo first; sleep 0.4; echo 'listening on 3000'; sleep 30",
    name: "server",
    onExit: "none",
  });

  const ready = await h.call("background_wait", { id: "bg-1", pattern: "listening on \\d+", timeoutSeconds: 5 });
  assert.match(ready.text, /Pattern matched: "listening on 3000"/);
  assert.match(ready.text, /first\nlistening on 3000/);

  const again = await h.call("background_read", { id: "bg-1" });
  assert.match(again.text, /New output: \(none\)/);

  const tail = await h.call("background_read", { id: "bg-1", tail: 1 });
  assert.match(tail.text, /Last 1 lines:\nlistening on 3000$/);
  assert.doesNotMatch(tail.text, /first|skipped/);

  const timeout = await h.call("background_wait", { id: "bg-1", pattern: "never", timeoutSeconds: 1 });
  assert.match(timeout.text, /Timed out after 1s/);
});

test("background_stop stops the job and suppresses the exit message", async () => {
  const h = harness();
  await h.call("background_run", { command: "sleep 30" });
  const stop = await h.call("background_stop", { id: "bg-1" });
  assert.match(stop.text, /Stopped \[bg-1\]/);
  assert.equal(stop.details.job.status, "stopped");

  const list = await h.call("background_list", {});
  assert.match(list.text, /\[bg-1\] "sleep 30" — stopped/);
  await sleep(300);
  assert.equal(h.messages.length, 0);
});

test("errors: unknown job, invalid regex, missing cwd", async () => {
  const h = harness();
  await assert.rejects(h.call("background_read", { id: "bg-99" }), /not found/);
  await h.call("background_run", { command: "sleep 30", onExit: "none" });
  await assert.rejects(h.call("background_wait", { id: "bg-1", pattern: "(" }), /Invalid regex/);
  await assert.rejects(h.call("background_run", { command: "true", cwd: "/does/not/exist" }), /does not exist/);
});

test("session_shutdown stops jobs without notifying", async () => {
  const h = harness();
  const run = await h.call("background_run", { command: "sleep 30" });
  const pid = run.details.job.pid as number;
  await h.shutdown();
  current = undefined;
  await sleep(200);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(h.messages.length, 0);
});

test("other extensions: API on request, events on the bus", async () => {
  const h = harness();
  let api: BackgroundsApi | undefined;
  h.pi.events.on(API_CHANNEL, (data: unknown) => (api = data as BackgroundsApi));
  const events: string[] = [];
  h.pi.events.on(EVENT_CHANNEL, (e: any) => events.push(`${e.type}:${e.job.status}`));

  h.pi.events.emit(REQUEST_API_CHANNEL, undefined);
  assert.equal(api?.version, 1);

  const job = await api!.start({ command: "echo via-api", onExit: "none" });
  assert.equal(job.metadata.onExit, "none");
  const result = await api!.wait(job.id, { timeoutMs: 5000 });
  assert.equal(result.job.status, "succeeded");
  assert.equal((await api!.read(job.id)).text, "via-api\n");

  await sleep(300);
  assert.ok(events.includes("start:starting"));
  assert.ok(events.includes("status:running"));
  assert.ok(events.includes("exit:succeeded"));
  assert.ok(events.some((e) => e.startsWith("output:")));
  assert.equal(h.messages.length, 0);
});

// ── Widget ───────────────────────────────────────────────────────────────────

const plainTheme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function fakeJob(overrides: Partial<JobInfo>): JobInfo {
  return {
    id: "bg-1",
    name: "dev-server",
    command: "npm run dev",
    cwd: "/tmp",
    backend: "local",
    status: "running",
    startedAt: 1_000_000,
    logFile: "/tmp/bg-1.log",
    metadata: {},
    ...overrides,
  };
}

test("widget: running and recently finished jobs, exact width", () => {
  const now = 1_000_000 + 75_000;
  const jobs = [
    fakeJob({}),
    fakeJob({ id: "bg-2", name: "tests", status: "failed", exitCode: 1, endedAt: now - 1000 }),
    fakeJob({ id: "bg-3", name: "old", status: "succeeded", exitCode: 0, endedAt: now - LINGER_MS - 1 }),
  ];
  assert.deepEqual(visibleJobs(jobs, now).map((j) => j.id), ["bg-1", "bg-2"]);

  for (const width of [40, 80, 120]) {
    const lines = renderWidgetLines(jobs, plainTheme, width, now);
    assert.equal(lines.length, 5);
    for (const line of lines) assert.equal(visibleWidth(line), width, `width ${width}: "${line}"`);
    assert.match(lines[0]!, /1 active/);
  }
  const lines = renderWidgetLines(jobs, plainTheme, 80, now);
  assert.match(lines[1]!, /bg-1 dev-server.*1m 15s/);
  assert.match(lines[2]!, /bg-2 tests.*failed \(exit 1\)/);
  assert.equal(statusText(jobs), "⚙ 1 bg");
  assert.deepEqual(renderWidgetLines([], plainTheme, 80, now), []);
});
