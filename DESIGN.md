# pi-ww-backjobs — Design

## Scope

pi-ww-backjobs does **one thing**: manage background processes.

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
unavailable backend, durable job without `durableDir` or on a backend
without `reattach`). If the process cannot be spawned, the job is still
registered and ends as `failed` with `error` set.

## Durable jobs

`start({ lifetime: "durable" })` (default `"session"`). A durable job
outlives the manager and the host process; a later manager with the same
`durableDir` finds it again with `reattach()`.

Registry (`durableDir`, one directory per pi session in the adapter):

| File | Content |
|---|---|
| `bg-N.json` | record: id, name, command, cwd, backend, status, pid, process start time, exit code/signal, error, times, log/exit paths, metadata. **Never the environment.** Written atomically (tmp + rename). |
| `bg-N.log`  | combined output, as for session jobs |
| `bg-N.exit` | exit status written by the wrapper when the command ends |

- **Intent first**: the record is written with status `starting` before the
  spawn, then updated with pid and start time. If the intent cannot be
  written, the job is **not spawned** (it ends `failed`): a durable job that
  nobody could find again must not run. Later write errors are only logged
  (the exit file stays the truth). Every status change is persisted
  **before** its events are emitted. A stale exit file with the same id is
  removed before the spawn.
- The directory is created with mode `0700`: records and logs hold full
  command lines and output.
- **Exit file**: after a restart the host is no longer the parent and cannot
  `wait()`. The local backend runs durable commands inside a small wrapper
  (`bash -c <wrapper> <shell> <command> <exit file>`) that traps
  TERM/INT/HUP, waits for the command and writes its status atomically.
  Only a `SIGKILL` of the wrapper leaves no exit file. Status > 128 is
  reported as the matching signal.
- **Process identity**: the backend records the process start time
  (`/proc/<pid>/stat` on Linux, `ps -o lstart` with `LC_ALL=C TZ=UTC`
  elsewhere). A live pid with a different start time is a reused pid, not
  the job. The check runs at reattach time.
- Durable jobs are not in the exit-hook kill list, are `unref()`ed, and are
  not stopped by `dispose()`: it waits for durable starts in progress (so
  their pid is recorded), then releases the jobs. A released job is never
  signalled or written again by that manager: pending waits resolve
  `aborted`, a pending `stop()` returns without escalating to `SIGKILL`.
- Status > 128 in the exit file is reported as the matching signal, so an
  explicit `exit 130` reads as `SIGINT` (shell convention; bash cannot tell
  the two apart).

`reattach()` loads every record of the directory not already known, in id
order. Records that are not valid (bad JSON, other version, id not matching
the file name, unknown status) are skipped with a log line. The log path is
always `<dir>/<id>.log`, never taken from the record.

| Record | Found | Result |
|---|---|---|
| terminal | – | loaded as is, **no events** (already reported) |
| not terminal | exit file | `succeeded` / `failed` / `stopped` with the real code, `endedAt` = exit file time; `status` + `exit` emitted now |
| not terminal | pid alive, same start time | `running`, followed again (polling for the exit file / pid) |
| not terminal | anything else (no pid, pid gone, pid reused) | `lost` with the reason in `error`; `status` + `exit` emitted |

A job is **never restarted**. What `lost` means for a given operation, and how
to verify it, belongs to whoever started the job. Since the terminal status
is persisted before `exit` is emitted, an exit is reported at most once across
hosts. Ids continue after the highest id of the registry.

Finished durable jobs are not pruned by `maxFinishedJobs`; `remove()` and
`removeFinished()` delete their record, log and exit file.

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

- Finished session jobs are kept in memory up to `maxFinishedJobs`
  (default 50), oldest removed first along with their log file.
- `dispose()` stops all running session jobs and removes temp files;
  durable jobs keep running (see Durable jobs).

## pi adapter

### Tools
| Tool | Purpose |
|---|---|
| `background_run`  | start a job: `command`, `name?`, `cwd?`, `onExit?`, `lifetime?` |
| `background_list` | list jobs |
| `background_read` | `id`, `tail?`: new output since the agent's last read, or last N lines |
| `background_wait` | `id`, `pattern?` (regex), `timeoutSeconds?` (default 60, max 1800) |
| `background_stop` | `id` |

The adapter keeps one read cursor per job for the agent: `background_read`
and `background_wait` return and match only output the agent has not seen.

The process manager is created lazily (first tool call or API call) and
disposed on `session_shutdown`.

Durable state: `$PI_WW_BACKJOBS_STATE_DIR`, else
`${XDG_STATE_HOME:-~/.local/state}/pi-ww-backjobs`, with one subdirectory
per pi session id (`sessionManager.getSessionId()`, sanitized). At
`session_start`, if the directory of the session exists, the manager is
created and `reattach()` runs: a session sees only its own durable jobs, so
`/reload` and `--resume` find them and other sessions do not. Without a
session id, `lifetime: "durable"` is refused.

`/bg clean [days]` removes finished jobs of the session and, in other session
directories, records that ended (or whose process is gone) more than `days`
ago (default 7); a record with an exit file counts as ended at the file's
time. Only valid durable records (`bg-N.json`, version 1, matching id, known
status) and their `.log` / `.exit` files are deleted, plus stale `*.tmp`
leftovers; empty session directories are removed.

A manager created before `session_start` (another extension calling the API
early) has no durable directory: it is replaced at `session_start` while it
has no jobs.

### Exit notification (`onExit`)
Chosen per job by whoever starts it. Default: `wake`.

| Value    | Effect when the job ends |
|----------|--------------------------|
| `wake`   | `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`: if idle, the agent starts a new turn; if busy, it reads the message before stopping |
| `inform` | `sendMessage(..., { triggerTurn: false })`: stored in the session, no new turn |
| `none`   | no message; widget and events only |

The message contains id, name, status, exit code, duration and the last
lines of output.

- No message when the agent already learned the outcome from a tool result
  (`background_wait` returning `exit`, `background_stop`, `background_read`
  of a finished job). The check runs on the next macrotask, after those
  tool calls marked the job.
- A job stopped by the user from `/bg` downgrades `wake` to `inform`.
- No messages during `session_shutdown`.
- A durable job that ended while pi was not running is reported when the
  session is reattached. A durable `lost` job's message says that it was
  not restarted and that its effect must be checked before re-running it.

### User visibility
- Widget above the editor: running jobs plus recently finished ones.
- Footer status: number of active jobs.
- `/bg` and `Ctrl+Alt+B`: list, read output, stop, remove.

### Integration with other extensions (`pi.events`)
- `pi-ww-backjobs:event` — every core event `{ type, job }`.
- `pi-ww-backjobs:api` — the extension emits its public API object at load
  and again whenever it receives `pi-ww-backjobs:request-api`, so load order
  does not matter.

## Open questions
- Herdr backend: how it writes the log file (`script`, `tee`, or pane read).
- ~~Reattach to running jobs after a pi reload~~: done for the local backend
  (see Durable jobs). Herdr backend: not supported (no `reattach`).
