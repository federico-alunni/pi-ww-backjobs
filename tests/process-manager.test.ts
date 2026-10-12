import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { LocalBackend } from "../src/backends/local.ts";
import { ProcessManager } from "../src/core/process-manager.ts";
import type { Backend, JobEvent } from "../src/core/types.ts";

const managers: ProcessManager[] = [];
function createManager(extra: Backend[] = []): ProcessManager {
  const manager = new ProcessManager({ backends: [new LocalBackend(), ...extra] });
  managers.push(manager);
  return manager;
}
after(async () => {
  await Promise.all(managers.map((m) => m.dispose()));
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("successful job: running → succeeded, output captured, events in order", async () => {
  const manager = createManager();
  const events: string[] = [];
  for (const type of ["start", "status", "exit"] as const) {
    manager.on(type, (e: JobEvent) => events.push(e.type === "status" ? `status:${e.job.status}` : e.type));
  }

  const job = await manager.start({ command: "echo hello; echo world", name: "greet" });
  assert.equal(job.status, "running");
  assert.equal(job.name, "greet");
  assert.ok(job.pid);

  const result = await manager.wait(job.id, { timeoutMs: 5000 });
  assert.equal(result.reason, "exit");
  assert.equal(result.job.status, "succeeded");
  assert.equal(result.job.exitCode, 0);
  assert.ok(result.job.endedAt);

  const out = await manager.read(job.id);
  assert.equal(out.text, "hello\nworld\n");
  assert.equal(out.eof, true);
  assert.deepEqual(events, ["start", "status:running", "status:succeeded", "exit"]);
});

test("non-zero exit → failed with exit code", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "echo oops >&2; exit 3" });
  const { job: done } = await manager.wait(job.id, { timeoutMs: 5000 });
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 3);
  assert.equal((await manager.read(job.id)).text, "oops\n");
});

test("command text is passed to the shell untouched (no extra interpolation)", async () => {
  const manager = createManager();
  const job = await manager.start({ command: `printf '%s\\n' "a \\"quoted\\" \\$HOME"` });
  await manager.wait(job.id, { timeoutMs: 5000 });
  assert.equal((await manager.read(job.id)).text, 'a "quoted" $HOME\n');
});

test("incremental read with cursor and tail", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "echo one; echo two; sleep 0.3; echo three" });
  await manager.wait(job.id, { until: { pattern: "two" }, timeoutMs: 5000 });

  const first = await manager.read(job.id);
  assert.equal(first.text, "one\ntwo\n");
  assert.equal(first.eof, false);

  await manager.wait(job.id, { timeoutMs: 5000 });
  const second = await manager.read(job.id, { cursor: first.cursor });
  assert.equal(second.text, "three\n");
  assert.equal(second.eof, true);

  const tail = await manager.read(job.id, { tail: 2 });
  assert.equal(tail.text, "two\nthree");
  assert.equal(tail.truncated, true);
});

test("read with maxBytes keeps the latest output", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "for i in $(seq 1 100); do echo line$i; done" });
  await manager.wait(job.id, { timeoutMs: 5000 });
  const out = await manager.read(job.id, { maxBytes: 20 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.endsWith("line100\n"));
  assert.ok(!out.text.includes("line1\n"));
});

test("wait for pattern: matches output printed before wait() and regex", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "echo 'server ready on port 4321'; sleep 30" });
  await new Promise((r) => setTimeout(r, 400));

  const literal = await manager.wait(job.id, { until: { pattern: "ready" }, timeoutMs: 5000 });
  assert.equal(literal.reason, "match");
  assert.equal(literal.job.status, "running");

  const regex = await manager.wait(job.id, { until: { pattern: /port (\d+)/ }, timeoutMs: 5000 });
  assert.equal(regex.match, "port 4321");
  await manager.stop(job.id, { graceMs: 1000 });
});

test("wait for pattern ends with exit when the pattern never appears", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "echo nope" });
  const result = await manager.wait(job.id, { until: { pattern: "never" }, timeoutMs: 5000 });
  assert.equal(result.reason, "exit");
});

test("wait timeout and abort leave the job running", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "sleep 30" });

  const timeout = await manager.wait(job.id, { timeoutMs: 100 });
  assert.equal(timeout.reason, "timeout");
  assert.equal(timeout.job.status, "running");

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const aborted = await manager.wait(job.id, { signal: controller.signal });
  assert.equal(aborted.reason, "aborted");
  assert.equal(manager.get(job.id)?.status, "running");
  await manager.stop(job.id, { graceMs: 1000 });
});

test("stop: running → stopping → stopped, kills the whole process group", async () => {
  const manager = createManager();
  const statuses: string[] = [];
  manager.on("status", (e) => statuses.push(e.job.status));

  const job = await manager.start({ command: "sleep 30 & echo child=$!; wait" });
  const { match } = await manager.wait(job.id, { until: { pattern: /child=\d+/ }, timeoutMs: 5000 });
  const childPid = Number(match!.split("=")[1]);
  assert.ok(isAlive(childPid));

  const stopped = await manager.stop(job.id, { graceMs: 2000 });
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(statuses, ["running", "stopping", "stopped"]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(isAlive(childPid), false);
});

test("stop escalates to SIGKILL when SIGTERM is ignored", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "trap '' TERM; echo armed; while true; do sleep 0.1; done" });
  await manager.wait(job.id, { until: { pattern: "armed" }, timeoutMs: 5000 });

  const startedAt = Date.now();
  const stopped = await manager.stop(job.id, { graceMs: 300 });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.signal, "SIGKILL");
  assert.ok(Date.now() - startedAt >= 300);
});

test("process killed by an unrequested signal → failed with signal", async () => {
  const manager = createManager();
  const job = await manager.start({ command: "sleep 30" });
  process.kill(-job.pid!, "SIGTERM");
  const { job: done } = await manager.wait(job.id, { timeoutMs: 5000 });
  assert.equal(done.status, "failed");
  assert.equal(done.signal, "SIGTERM");
});

test("invalid input throws; spawn failure registers a failed job", async () => {
  const manager = createManager([
    {
      name: "broken",
      isAvailable: () => true,
      start: async () => {
        throw new Error("boom");
      },
    },
    { name: "offline", isAvailable: () => false, start: async () => ({ signal: async () => {} }) },
  ]);

  await assert.rejects(manager.start({ command: "  " }), /empty/);
  await assert.rejects(manager.start({ command: "true", backend: "nope" }), /Unknown backend/);
  await assert.rejects(manager.start({ command: "true", backend: "offline" }), /not available/);
  await assert.rejects(manager.start({ command: "true", cwd: "/does/not/exist" }), /does not exist/);

  const exits: string[] = [];
  manager.on("exit", (e) => exits.push(e.job.id));
  const job = await manager.start({ command: "true", backend: "broken" });
  assert.equal(job.status, "failed");
  assert.equal(job.error, "boom");
  assert.deepEqual(exits, [job.id]);
});

test("metadata, env and cwd are honoured", async () => {
  const manager = createManager();
  const job = await manager.start({
    command: "echo $WW_TEST_VAR; pwd",
    cwd: "/tmp",
    env: { WW_TEST_VAR: "from-env" },
    metadata: { onExit: "inform" },
  });
  await manager.wait(job.id, { timeoutMs: 5000 });
  const [envLine, cwdLine] = (await manager.read(job.id)).text.trim().split("\n");
  assert.equal(envLine, "from-env");
  assert.match(cwdLine!, /\/tmp$/);
  assert.deepEqual(manager.get(job.id)?.metadata, { onExit: "inform" });
});

test("remove refuses running jobs; finished jobs are pruned with their logs", async () => {
  const manager = new ProcessManager({ backends: [new LocalBackend()], maxFinishedJobs: 2 });
  managers.push(manager);

  const running = await manager.start({ command: "sleep 30" });
  await assert.rejects(manager.remove(running.id), /stop it/);

  const done = [];
  for (let i = 0; i < 3; i++) {
    const job = await manager.start({ command: `echo ${i}` });
    await manager.wait(job.id, { timeoutMs: 5000 });
    done.push(job);
  }
  assert.equal(manager.get(done[0]!.id), undefined);
  assert.equal(existsSync(done[0]!.logFile), false);
  assert.ok(manager.get(done[2]!.id));
  await manager.stop(running.id, { graceMs: 1000 });
});

test("dispose stops running jobs and removes the log directory", async () => {
  const manager = new ProcessManager({ backends: [new LocalBackend()] });
  const job = await manager.start({ command: "sleep 30" });
  await manager.dispose();
  assert.equal(isAlive(job.pid!), false);
  assert.equal(existsSync(job.logFile), false);
  await assert.rejects(manager.start({ command: "true" }), /disposed/);
});

test("output events stream new chunks", async () => {
  const manager = createManager();
  const chunks: string[] = [];
  manager.on("output", (e) => chunks.push(e.chunk));
  const job = await manager.start({ command: "echo a; sleep 0.4; echo b" });
  await manager.wait(job.id, { timeoutMs: 5000 });
  assert.equal(chunks.join(""), "a\nb\n");
  assert.ok(chunks.length >= 2);
});
