# ww-backgrounds — Design

## Scope

ww-backgrounds does **one thing**: manage background processes.

In scope:
- start a process without blocking the caller
- list jobs, inspect status and exit code
- read output (incremental, backed by a log file)
- wait for exit, for an output pattern, or for a timeout
- stop a process (graceful → forced, whole process group)
- clean up files and processes
- emit lifecycle events

Out of scope:
- observing the agent's regular (foreground) `bash` calls
- terminal / tab / layout management beyond hosting a job
- use-case specific logic (dev servers, ports, subagents, ...)

## Layers

```
src/core/       pure Node, no pi and no Herdr imports
                ProcessManager, state machine, events, log files
src/backends/   where a job actually runs (Backend interface)
                - local  (default) child_process, detached process group
                - herdr  (opt-in)  real terminal visible to the user
src/pi/         thin pi adapter: tools, widget, /bg, exit notification,
                pi.events bridge
```

Dependency rule: `pi → core ← backends`. `core` never imports `pi` or a
concrete backend. The package is a pi extension; the split exists to keep
responsibilities clear and `core` testable without pi.

## Job lifecycle

```
starting ──► running ──► succeeded   (exit code 0)
   │            │  └──► failed       (exit code ≠ 0)
   │            │  └──► lost         (backend lost track of the process)
   │            ▼
   │         stopping ──► stopped    (stop() requested, process gone)
   │
   └──► failed                       (spawn error, `error` is set)
```

- Terminal states: `succeeded`, `failed`, `stopped`, `lost`.
- `stopping` exists so that `stop()` never claims "stopped" before the
  process is really gone.
- A process killed by a signal that was **not** requested through `stop()`
  ends as `failed` with `signal` set.
- Status only moves forward; every transition emits `status`.

## Output

- Every job has one log file with combined stdout + stderr.
- The backend MUST write the output to that file.
- Reads are cursor based (byte offsets): a caller passes the cursor of its
  last read and gets only new output, plus the next cursor.
- `tail` reads the last N lines regardless of cursor.
- Reads are bounded (`maxBytes`). When more new output is available, the
  oldest part is skipped (`truncated: true`) and the cursor moves to the end:
  the latest output matters most.

## Start

`start()` throws only for invalid input (empty command, unknown or
unavailable backend). If the process cannot be spawned, the job is still
registered and ends as `failed` with `error` set.

## Local backend

- POSIX only (macOS, Linux) in v1.
- Each job runs as `bash -c <command>` (`/bin/sh` if bash is missing) in its
  own process group (`detached`), stdout + stderr appended to the log file.
- A job is the whole process group: when the leader exits, leftover group
  members (e.g. `cmd &`) are killed.
- If the host process exits abruptly, live groups get `SIGKILL`.

## Stop

`stop(id)` sends `SIGTERM` to the whole process group, waits `graceMs`
(default 5000), then sends `SIGKILL`. It resolves with the final job info.

## Wait

`wait(id, { until, timeoutMs, signal })` resolves with a reason:
- `exit`    the job reached a terminal state
- `match`   the pattern matched new output (`until: { pattern }`)
- `timeout` `timeoutMs` elapsed, the job keeps running
- `aborted` the caller's AbortSignal fired, the job keeps running

Pattern matching starts at `cursor` (default 0), so output printed before
`wait()` was called still counts.

## Events (core)

| Event    | When |
|----------|------|
| `start`  | job created and process spawned |
| `status` | any status transition |
| `output` | new output appended to the log (throttled) |
| `exit`   | job reached a terminal state (exactly once) |

## Retention and shutdown

- Finished jobs are kept in memory up to `maxFinishedJobs` (default 50),
  oldest removed first along with their log file.
- `dispose()` stops all running jobs and removes temp files. Jobs do not
  outlive the manager in v1 (no reattach after restart; see Open questions).

## pi adapter

### Tools
| Tool | Purpose |
|---|---|
| `background_run`  | start a job; parameter `onExit` (see below) |
| `background_list` | list jobs |
| `background_read` | new output since the agent's last read (or `tail`) |
| `background_wait` | wait for exit / pattern / timeout |
| `background_stop` | stop a job |

### Exit notification (`onExit`)
Chosen per job by whoever starts it. Default: `wake`.

| Value    | Effect when the job ends |
|----------|--------------------------|
| `wake`   | `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`: if idle, the agent starts a new turn; if busy, it reads the message before stopping |
| `inform` | `sendMessage(..., { triggerTurn: false })`: stored in the session, no new turn |
| `none`   | no message; widget and events only |

The message contains id, name, status, exit code, duration and the last
lines of output.

### User visibility
- Widget above the editor: running jobs plus recently finished ones.
- `/bg` and `Ctrl+Alt+B`: list, read output, stop, remove.

### Integration with other extensions (`pi.events`)
- `ww-backgrounds:event` — every core event `{ type, job }`.
- `ww-backgrounds:api` — the extension emits its public API object at load
  and again whenever it receives `ww-backgrounds:request-api`, so load order
  does not matter.

## Open questions
- Herdr backend: how it writes the log file (`script`, `tee`, or pane read).
- Reattach to running jobs after a pi reload (registry file + pid).
