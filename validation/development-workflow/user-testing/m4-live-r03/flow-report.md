# M4-LIVE-R03 Validation-Only Direct-CDP Flow Report

## Outcome

**Blocked after exact target and process loss.**

This report supplements `M4-F03` without changing assertion ownership. The
harness was validation-only. It did not establish public lifecycle ownership,
current compatibility, persisted plugin authority, or a public CLI operation.

The operation initially froze and revalidated the authorized identity:

- canonical host `/Applications/ChatGPT.app`, version `26.721.41059`, build
  `5848`, bundle ID `com.openai.codex`, signing team `2DC432GLL2`;
- PID `76069` with kernel identity `113245930.161864995`;
- owned child/listener PID `76398` with kernel identity
  `113246247.161865506`;
- both listener owners on `127.0.0.1:9444`;
- browser `Chrome/150.0.7871.128`, protocol `1.3`;
- shell target `320892B4AB2506B37CF08E743DB39053`;
- overlay target `B7FBA1D17F480337F3092F9D855B8D6B`;
- signed-in shell URL, composer, profile, default-context
  `performance.timeOrigin`, and `electronBridge.sendMessageFromView`;
- current generated SDK IIFE, 85,623 bytes, SHA-256
  `cde97e29af89a35b737406bd038212c94752b43ec3d24ab74b87aeb480e03ec4`;
- unchanged development and compatibility state hashes, with
  `plugins.json` absent.

The exact-page browser session initially correlated to the shell URL. The next
SDK evaluation result reported `about:blank`, not `app://-/index.html`. The
session then exposed only one `about:blank` tab, while PID `76069`, PID `76398`,
listener `9444`, and both authorized targets were absent. This triggered the
mandatory stop rule.

No review, approval, plugin setup, update, disable, removal, reinstall,
management action, or final reload was attempted after drift. The worker did
not reconnect, select a replacement, relaunch, recover, adopt, stop, or signal
any process.

## Requirements and Stop Classification

| Requirement | Result |
| --- | --- |
| Identify harness as validation-only | Pass |
| Leave public ownership and compatibility unproven | Pass |
| Never write `plugins.json`, compatibility, or dev state | Pass, hashes and mtimes remained unchanged |
| Attach only to exact shell target | Initial attachment correlated; subsequent SDK evaluation did not |
| Revalidate before every renderer effect | Baseline revalidation passed; flow stopped when post-bootstrap correlation failed |
| Exercise review and runtime surfaces | Blocked by target/process loss |
| Perform one final same-target reload | Not performed because the same target did not survive |
| Preserve PID `76069`, child `76398`, both targets, and `9444` | Failed as an environment prerequisite; all disappeared |
| Leave protected `9333` untouched | Pass, existing `Comet` PID `22810` listener survived unchanged |
| Close harness session and remove harness-owned resources | Pass, agent-browser reports no active sessions |

The disappearing process and automatic `about:blank` fallback make the live
evidence unsuitable for any exact-target application claim. The flow is
therefore blocked, not partially passed.

## Accepted Controlled Evidence

Focused validation refreshed the accepted M3/M4 fixture surfaces:

- SDK runtime tests: **19 passed, 0 failed**.
- CLI review, callback cleanup, application, reconciliation, update, disable,
  removal, reinstall, development ownership, and drift tests:
  **52 passed, 0 failed**.

These fixtures remain evidence for algorithms, authority ordering, state
schemas, locks, interruption, immutable snapshot handling, lifecycle truth,
and cleanup. They do not substitute for the missing factual selected-ChatGPT
renderer observations.

## Assertion Classification

The complete per-assertion table is in `flow-report.json`.

- **Pass:** 0
- **Blocked:** 32
- **Pending:** 3

As required, these remain blocked or pending:

- `VAL-DEV-012`: blocked, direct evaluation is not public inject authority and
  exact-target SDK application was not correlated.
- `VAL-DEV-024`: pending, no renderer-start boundary completed and app-start
  process replacement was forbidden.
- `VAL-CROSS-003`: blocked, public ownership/current compatibility and plugin
  intent preservation were not independently established.
- `VAL-CROSS-004`: pending, factual lifecycle boundaries did not complete.
- `VAL-CROSS-011`: blocked, no public committed boundary-required result or
  surviving management/status surface existed.

`VAL-CROSS-010` is blocked rather than passed. The operation stopped on factual
target/process loss, but the automation tool's uncorrelated `about:blank`
fallback prevents accepting this as exact-target product drift evidence.

## Safety and Final Inventory

- ChatGPT.app hashes remained unchanged.
- Generated SDK bytes and digest remained unchanged.
- Development state and compatibility state hashes and mtimes remained
  unchanged.
- `plugins.json` remained absent.
- No future-document script was registered.
- No target close, navigation, or reload command was issued.
- No process start, stop, signal, restart, replacement, or recovery command was
  issued.
- Protected `127.0.0.1:9333` remained owned by `Comet` PID `22810`.
- The agent-browser session was closed and no active session remains.

Final observed disposition:

- PID `76069`: absent.
- PID `76398`: absent.
- `127.0.0.1:9444`: no listener.
- shell target: absent.
- overlay target: absent.

## Smallest Next Action

Return to the orchestrator. Another live attempt requires a new explicitly
authorized exact process and target identity, plus a browser tool path that can
bind evaluation and context inventory to the exact target without automatic
fallback. This feature does not authorize restarting or adopting the historical
development root.

## Evidence Index

- `01-frozen-baseline.txt`
- `02-session-attach.txt`
- `03-sdk-focused-tests.txt`
- `04-agent-browser-debug-eval.txt`
- `05-revalidate-before-bootstrap.json`
- `05-revalidate-debug.txt`
- `06-sdk-bootstrap.json`
- `07-runtime-debug.json`
- `08-drift-stop-inventory.txt`
- `09-agent-browser-close.txt`
- `10-final-stop-inventory.txt`
- `11-cli-focused-tests.txt`
- `revalidate.sh`
- `flow-report.json`
