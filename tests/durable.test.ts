import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { LocalBackend, isProcessAlive } from "../src/backends/local.ts";
import { ProcessManager } from "../src/core/process-manager.ts";
import type { Backend, JobEvent, JobInfo } from "../src/core/types.ts";
import { cleanupOtherSessions, sessionStateDir, stateRoot } from "../src/pi/durable-state.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roots: string[] = [];
const managers: ProcessManager[] = [];
const pids: number[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "backjobs-durable-"));
  roots.push(dir);
  return dir;
}

function createManager(durableDir: string, backend: Backend = new LocalBackend({ reattachPollMs: 50 })): ProcessManager {
  const manager = new ProcessManager({ backends: [backend], durableDir });
  managers.push(manager);
  return manager;
}

function track(manager: ProcessManager): string[] {
  const events: string[] = [];
  manager.on("status", (e: JobEvent) => events.push(`${e.job.id}:${e.job.status}`));
  manager.on("exit", (e: JobEvent) => events.push(`exit:${e.job.id}:${e.job.status}`));
  return events;
}

function record(dir: string, id: string): any {
  return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
}

after(async () => {
  await Promise.all(managers.map((m) => m.dispose()));
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("session jobs are still stopped by dispose; durable jobs keep running", async () => {
  const dir = tempDir();
  const manager = createManager(dir);
  const session = await manager.start({ command: "sleep 30" });
  const durable = await manager.start({ command: "sleep 30", lifetime: "durable" });
  pids.push(durable.pid!);
  assert.equal(session.lifetime, "session");
  assert.equal(durable.lifetime, "durable");
  assert.equal(durable.logFile, join(dir, `${durable.id}.log`));

  await manager.dispose();
  assert.equal(isProcessAlive(session.pid!), false);
  assert.equal(isProcessAlive(durable.pid!), true);
  assert.equal(record(dir, durable.id).status, "running");
  assert.ok(!existsSync(join(dir, `${session.id}.json`)), "session jobs are not persisted");
});

test("host process exit: session jobs are killed, durable ones survive and are reattached", async () => {
  const dir = tempDir();
  const src = resolve(import.meta.dirname, "../src");
  const script = `
    import { LocalBackend } from ${JSON.stringify(join(src, "backends/local.ts"))};
    import { ProcessManager } from ${JSON.stringify(join(src, "core/process-manager.ts"))};
    const m = new ProcessManager({ backends: [new LocalBackend()], durableDir: ${JSON.stringify(dir)} });
    const s = await m.start({ command: "sleep 30" });
    const d = await m.start({ command: "sleep 2; echo survived; exit 5", lifetime: "durable" });
    console.log(JSON.stringify({ session: s.pid, durable: d.pid, id: d.id }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  const { session, durable, id } = JSON.parse(out.trim().split("\n").at(-1)!);
  pids.push(durable);
  for (let i = 0; i < 20 && isProcessAlive(session); i++) await sleep(50);
  assert.equal(isProcessAlive(session), false, "session job killed by the exit hook");
  assert.equal(isProcessAlive(durable), true, "durable job survives the host");

  const manager = createManager(dir);
  const [job] = await manager.reattach();
  assert.equal(job!.status, "running");
  const { job: done } = await manager.wait(id, { timeoutMs: 5000 });
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 5);
  assert.equal((await manager.read(id)).text, "survived\n");
});

test("reattach: running job is followed again (read, wait, stop)", async () => {
  const dir = tempDir();
  const first = createManager(dir);
  const job = await first.start({ command: "echo before; sleep 0.4; echo ready; sleep 30", lifetime: "durable", metadata: { onExit: "inform" } });
  pids.push(job.pid!);
  await first.wait(job.id, { until: { pattern: "before" }, timeoutMs: 5000 });
  await first.dispose();

  const second = createManager(dir);
  const events = track(second);
  const [again] = await second.reattach();
  assert.equal(again!.id, job.id);
  assert.equal(again!.status, "running");
  assert.equal(again!.pid, job.pid);
  assert.deepEqual(again!.metadata, { onExit: "inform" });

  const match = await second.wait(job.id, { until: { pattern: "ready" }, timeoutMs: 5000 });
  assert.equal(match.reason, "match");
  assert.match((await second.read(job.id)).text, /before\nready\n/);

  const stopped = await second.stop(job.id, { graceMs: 2000 });
  assert.equal(stopped.status, "stopped");
  assert.equal(isProcessAlive(job.pid!), false);
  assert.deepEqual(events, [`${job.id}:stopping`, `${job.id}:stopped`, `exit:${job.id}:stopped`]);
  assert.equal(record(dir, job.id).status, "stopped");

  // New jobs never reuse a durable id.
  const next = await second.start({ command: "true" });
  assert.notEqual(next.id, job.id);
});

test("reattach: running job that later exits gets its real exit code", async () => {
  const dir = tempDir();
  const first = createManager(dir);
  const job = await first.start({ command: "sleep 0.3; echo bye; exit 4", lifetime: "durable" });
  pids.push(job.pid!);
  await first.dispose();

  const second = createManager(dir);
  const [again] = await second.reattach();
  assert.equal(again!.status, "running");
  const { job: done } = await second.wait(job.id, { timeoutMs: 5000 });
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 4);
  assert.equal((await second.read(job.id)).text, "bye\n");
});

test("job finished while nobody watched: reported once, with its exit code", async () => {
  const dir = tempDir();
  const first = createManager(dir);
  const job = await first.start({ command: "sleep 0.2; echo done", lifetime: "durable" });
  pids.push(job.pid!);
  await first.dispose();
  await sleep(700);
  assert.ok(existsSync(join(dir, `${job.id}.exit`)));

  const second = createManager(dir);
  const events = track(second);
  const [again] = await second.reattach();
  assert.equal(again!.status, "succeeded");
  assert.equal(again!.exitCode, 0);
  assert.ok(again!.endedAt! < Date.now() - 200, "endedAt is when it ended, not when it was found");
  assert.deepEqual(events, [`${job.id}:succeeded`, `exit:${job.id}:succeeded`]);
  await second.dispose();

  const third = createManager(dir);
  const later = track(third);
  const [still] = await third.reattach();
  assert.equal(still!.status, "succeeded");
  assert.deepEqual(later, [], "no second exit event");
});

test("signal ending a durable job is recorded by the wrapper", async () => {
  const dir = tempDir();
  const manager = createManager(dir);
  const job = await manager.start({ command: "sleep 30", lifetime: "durable" });
  pids.push(job.pid!);
  const stopped = await manager.stop(job.id, { graceMs: 2000 });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.signal, "SIGTERM");
  assert.equal(readFileSync(join(dir, `${job.id}.exit`), "utf8").trim(), "143");
  assert.doesNotMatch((await manager.read(job.id)).text, /\$1|Terminated/, "no wrapper noise in the log");
});

test("process gone without an exit file → lost, never restarted", async () => {
  const dir = tempDir();
  const first = createManager(dir);
  const job = await first.start({ command: "echo once >> marker; sleep 30", cwd: dir, lifetime: "durable" });
  pids.push(job.pid!);
  await sleep(300);
  await first.dispose();
  // Wrapper first: killing the group at once may let it record the exit (137).
  process.kill(job.pid!, "SIGKILL");
  process.kill(-job.pid!, "SIGKILL");
  await sleep(200);

  const second = createManager(dir);
  const events = track(second);
  const [again] = await second.reattach();
  assert.equal(again!.status, "lost");
  assert.match(again!.error!, /gone and left no exit status/);
  assert.deepEqual(events, [`${job.id}:lost`, `exit:${job.id}:lost`]);
  await sleep(200);
  assert.equal(readFileSync(join(dir, "marker"), "utf8"), "once\n", "command not run again");
});

test("reused pid (start time differs) is not mistaken for the job", async () => {
  const dir = tempDir();
  // A live process that is not the job: this test process, with a recorded
  // start time that does not match.
  writeFileSync(
    join(dir, "bg-7.json"),
    JSON.stringify({
      version: 1,
      id: "bg-7",
      name: "push",
      command: "git push",
      cwd: dir,
      backend: "local",
      status: "running",
      pid: process.pid,
      processStart: "ps:Thu Jan  1 00:00:00 1970",
      startedAt: Date.now() - 1000,
      logFile: join(dir, "bg-7.log"),
      exitFile: join(dir, "bg-7.exit"),
      metadata: {},
    }),
  );
  const manager = createManager(dir);
  const [job] = await manager.reattach();
  assert.equal(job!.status, "lost");
  assert.match(job!.error!, /pid now belongs to another process/);
  assert.equal(isProcessAlive(process.pid), true);
  // Ids continue after the registry's.
  assert.equal((await manager.start({ command: "true" })).id, "bg-8");
});

test("registry is written before the spawn and never contains the environment", async () => {
  const dir = tempDir();
  let seenAtSpawn: any;
  const local = new LocalBackend();
  const spy: Backend = {
    name: "local",
    isAvailable: () => true,
    start(spec, callbacks) {
      seenAtSpawn = record(dir, spec.id);
      return local.start(spec, callbacks);
    },
    reattach: (spec, callbacks) => local.reattach(spec, callbacks),
  };
  const manager = createManager(dir, spy);
  const job = await manager.start({
    command: "echo $SECRET_TOKEN",
    env: { SECRET_TOKEN: "hunter2-very-secret" },
    lifetime: "durable",
  });
  pids.push(job.pid!);
  await manager.wait(job.id, { timeoutMs: 5000 });

  assert.equal(seenAtSpawn.status, "starting");
  assert.equal(seenAtSpawn.pid, undefined);
  const saved = record(dir, job.id);
  assert.equal(saved.pid, job.pid);
  assert.equal(saved.status, "succeeded");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    assert.ok(!readFileSync(join(dir, file), "utf8").includes("hunter2"), `${file} has no env`);
  }
  assert.equal((await manager.read(job.id)).text, "hunter2-very-secret\n");
});

test("host died while starting (no pid recorded) → lost", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "bg-1.json"),
    JSON.stringify({
      version: 1, id: "bg-1", name: "x", command: "x", cwd: dir, backend: "local", status: "starting",
      startedAt: Date.now(), logFile: join(dir, "bg-1.log"), exitFile: join(dir, "bg-1.exit"), metadata: {},
    }),
  );
  const [job] = await createManager(dir).reattach();
  assert.equal(job!.status, "lost");
  assert.match(job!.error!, /never recorded/);
});

test("durable requires a durable dir; finished durable jobs are not auto-pruned; removeFinished cleans files", async () => {
  const plain = new ProcessManager({ backends: [new LocalBackend()] });
  managers.push(plain);
  await assert.rejects(plain.start({ command: "true", lifetime: "durable" }), /durable directory/);

  const dir = tempDir();
  const manager = new ProcessManager({ backends: [new LocalBackend()], durableDir: dir, maxFinishedJobs: 1 });
  managers.push(manager);
  const jobs: JobInfo[] = [];
  for (let i = 0; i < 3; i++) jobs.push(await manager.start({ command: "true", lifetime: "durable" }));
  for (const job of jobs) await manager.wait(job.id, { timeoutMs: 5000 });
  assert.equal(manager.list().length, 3);

  const removed = await manager.removeFinished();
  assert.equal(removed.length, 3);
  assert.deepEqual(readdirSync(dir), []);
});

test("cleanupOtherSessions removes old finished and orphaned records, keeps live and current ones", () => {
  const root = tempDir();
  const now = Date.now();
  const old = now - 10 * 86_400_000;
  const write = (session: string, id: string, data: Record<string, unknown>) => {
    const dir = join(root, session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 1, id, ...data }));
    writeFileSync(join(dir, `${id}.log`), "log");
  };
  write("s-old", "bg-1", { status: "succeeded", startedAt: old, endedAt: old });
  write("s-mixed", "bg-1", { status: "failed", startedAt: old, endedAt: now });
  write("s-mixed", "bg-2", { status: "running", pid: 999_999, startedAt: old });
  write("s-mixed", "bg-3", { status: "running", pid: process.pid, startedAt: old });
  write("s-current", "bg-1", { status: "succeeded", startedAt: old, endedAt: old });
  // Not durable records: never touched, whatever the root contains.
  mkdirSync(join(root, "project"));
  writeFileSync(join(root, "project", "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(root, "project", "bg-9.json"), JSON.stringify({ id: "bg-9", startedAt: 0 }));
  writeFileSync(join(root, "project", "bg-8.json"), JSON.stringify({ version: 1, id: "bg-8", status: "weird", startedAt: 0 }));

  const result = cleanupOtherSessions(root, { excludeDir: join(root, "s-current"), olderThanMs: 7 * 86_400_000, now });
  assert.deepEqual(result, { removedJobs: 2, removedSessions: 1 });
  assert.deepEqual(readdirSync(join(root, "project")).sort(), ["bg-8.json", "bg-9.json", "package.json"]);
  assert.ok(!existsSync(join(root, "s-old")));
  assert.deepEqual(readdirSync(join(root, "s-mixed")).sort(), ["bg-1.json", "bg-1.log", "bg-3.json", "bg-3.log"]);
  assert.ok(existsSync(join(root, "s-current", "bg-1.json")));
});

test("dispose during stop(): the durable job is left alone (no SIGKILL, no record rewrite)", async () => {
  const dir = tempDir();
  const manager = createManager(dir);
  const job = await manager.start({ command: "trap '' TERM; sleep 30", lifetime: "durable" });
  pids.push(job.pid!);
  await sleep(100);
  const stopping = manager.stop(job.id, { graceMs: 3000 });
  await sleep(100);
  await manager.dispose();
  const result = await stopping;
  assert.equal(result.status, "stopping");
  await sleep(200);
  assert.equal(isProcessAlive(job.pid!), true, "not escalated to SIGKILL");

  const next = createManager(dir);
  const [again] = await next.reattach();
  assert.equal(again!.status, "running");
  await sleep(300);
  assert.equal(record(dir, job.id).status, "running", "the disposed manager did not overwrite it");
  const stopped = await next.stop(job.id, { graceMs: 200 });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.error, undefined, "a requested stop is not an error");
});

test("dispose during a durable start(): the pid is recorded before letting go", async () => {
  const dir = tempDir();
  const local = new LocalBackend();
  const slow: Backend = {
    name: "local",
    isAvailable: () => true,
    async start(spec, callbacks) {
      await sleep(150);
      return local.start(spec, callbacks);
    },
    reattach: (spec, callbacks) => local.reattach(spec, callbacks),
  };
  const manager = createManager(dir, slow);
  const starting = manager.start({ command: "sleep 30", lifetime: "durable" });
  await sleep(20);
  await manager.dispose();
  const job = await starting;
  pids.push(job.pid!);
  assert.ok(record(dir, job.id).pid, "pid persisted");

  const [again] = await createManager(dir).reattach();
  assert.equal(again!.status, "running");
});

test("reattach skips corrupt or foreign records and keeps going", async () => {
  const dir = tempDir();
  const base = { version: 1, name: "x", command: "x", cwd: dir, backend: "local", startedAt: Date.now(), metadata: {} };
  writeFileSync(join(dir, "bg-1.json"), "{ not json");
  writeFileSync(join(dir, "bg-2.json"), JSON.stringify({ ...base, id: "bg-2", status: "weird" }));
  writeFileSync(join(dir, "bg-3.json"), JSON.stringify({ ...base, id: "other", status: "succeeded" }));
  writeFileSync(join(dir, "bg-4.json"), JSON.stringify({ ...base, id: "bg-4", status: "succeeded", exitCode: 0, logFile: "/etc/hosts" }));
  const errors = console.error;
  console.error = () => {};
  try {
    const manager = createManager(dir);
    const jobs = await manager.reattach();
    assert.deepEqual(jobs.map((j) => j.id), ["bg-4"]);
    assert.equal(jobs[0]!.logFile, join(dir, "bg-4.log"), "log path derived, not trusted");
    assert.equal((await manager.start({ command: "true" })).id, "bg-5");
  } finally {
    console.error = errors;
  }
});

test("no record, no spawn: a durable start fails when the registry is not writable", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores permissions");
  const dir = tempDir();
  let spawned = false;
  const spy: Backend = {
    name: "local",
    isAvailable: () => true,
    async start() {
      spawned = true;
      throw new Error("should not spawn");
    },
    reattach: async () => ({ exit: { exitCode: null, signal: null } }),
  };
  chmodSync(dir, 0o500);
  try {
    const manager = createManager(dir, spy);
    const outcome = await manager.start({ command: "true", lifetime: "durable" }).then(
      (job) => job.status,
      () => "rejected",
    );
    assert.ok(outcome === "failed" || outcome === "rejected");
    assert.equal(spawned, false);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("durable directory is private (0700)", async () => {
  const dir = join(tempDir(), "session");
  const manager = createManager(dir);
  const job = await manager.start({ command: "true", lifetime: "durable" });
  await manager.wait(job.id, { timeoutMs: 5000 });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("state dir: env override, XDG, sanitized session id", () => {
  assert.equal(stateRoot({ PI_WW_BACKJOBS_STATE_DIR: "/x/y" }), "/x/y");
  assert.equal(stateRoot({ PI_WW_BACKJOBS_STATE_DIR: "rel" }), join(process.cwd(), "rel"));
  assert.equal(stateRoot({ XDG_STATE_HOME: "/state" }), "/state/pi-ww-backjobs");
  assert.match(stateRoot({}), /\.local\/state\/pi-ww-backjobs$/);
  assert.equal(sessionStateDir("/r", "../a b"), "/r/__a_b");
  assert.equal(sessionStateDir("/r", ".."), "/r/_");
  assert.equal(sessionStateDir("/r", "019a-uuid"), "/r/019a-uuid");
});
