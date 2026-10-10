import test from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/job-manager.ts";
import type { BackgroundJob } from "../src/types.ts";

test("JobManager notifies listeners on update", () => {
  const manager = new JobManager();
  manager.stopPolling();

  let called = false;
  const unsubscribe = manager.onUpdate(() => {
    called = true;
  });

  // Manually add a job to test internal state
  const mockJob: BackgroundJob = {
    id: "bg-test",
    name: "test",
    command: "echo test",
    cwd: "/test",
    paneId: "w1:p1",
    tabId: "w1:t1",
    tabLabel: "test",
    placement: "tab",
    status: "running",
    startedAt: Date.now(),
    statusFile: "/tmp/fake.status",
    scriptFile: "/tmp/fake.sh",
  };

  (manager as any).jobs.set(mockJob.id, mockJob);
  (manager as any).notify();

  assert.equal(called, true);
  assert.equal(manager.getAllJobs().length, 1);
  assert.equal(manager.getActiveJobs().length, 1);
  assert.equal(manager.getJob("bg-test")?.name, "test");

  unsubscribe();
  manager.dispose();
});
