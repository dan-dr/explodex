# M4-LIVE-R01 Supplemental Live Flow Report

## Outcome

**Blocked before mutation.** This report supplements `M4-F03` and does not
change assertion ownership.

The current process and both renderer targets were independently inventoried.
The signed-in main shell is target
`320892B4AB2506B37CF08E743DB39053`, while
`B7FBA1D17F480337F3092F9D855B8D6B` is the avatar-overlay page. That factual
role distinction was established from complete frame/default-context and UI
evidence, not from target order, title, or URL alone.

No current persisted ownership record authorizes either target. The current
public CLI rejects the development root as `nonempty_unowned_root`; persisted
development and compatibility records still identify dead PID `20441`, old
target `A1604314859E923F5B868660D1AFD633`, and old execution contexts. Current
PID `76069` has kernel start identity `113245930.161864995`. The public
compatibility verdict is `unproven` because the persisted SDK runtime digest
`81d936...` does not match the current CLI runtime digest `cde97e...`, and the
selected signed-in renderer currently has no `Explodex` runtime.

The operation therefore stopped before review, approval, injection,
reconciliation, update, disable, remove, reinstall, reload, or any renderer/app
boundary. No target was closed, reloaded, or replaced, no process was started,
stopped, signaled, or adopted, and port `9333` was not touched.

## Frozen Current Identity

- Host: `/Applications/ChatGPT.app`
- Version/build: `26.721.41059` / `5848`
- Bundle/team: `com.openai.codex` / `2DC432GLL2`
- Executable SHA-256:
  `d7bd5eacb7f59c42240e6c5dc62eebdeca9d09a0b59ed4c3ac3e2b55ef8d9336`
- Root PID/start: `76069@113245930.161864995`
- Root arguments include exact profile, `9444`, and marker
  `--explodex-dev-instance=plugin-dev`
- Companion PID/start:
  `76398@113246247.161865506`, parent `76069`,
  `SkyComputerUseService` under the private `codex-home`
- Listener: both PID `76069` and owned child PID `76398` listen on
  `127.0.0.1:9444`
- Browser/protocol: `Chrome/150.0.7871.128`, protocol `1.3`

## Target and Context Inventory

| Target | Factual role | Frame | Default context | Runtime facts |
| --- | --- | --- | --- | --- |
| `B7FBA1D17F480337F3092F9D855B8D6B` | Avatar overlay | Same ID | `1`, unique `9101070369226266857.6463750259086303294` | No composer, profile, or Explodex runtime |
| `320892B4AB2506B37CF08E743DB39053` | Signed-in main shell | Same ID | `1`, unique `-8694852523717988740.-7538271351644666559` | Composer and profile present, no sign-in prompt, no Explodex runtime |

The main-shell accessibility snapshot shows the profile name, project/chat
navigation, composer, and account controls. The avatar-overlay snapshot contains
only the pet image surface.

## Bridge and Loaded-Source Evidence

On exact target `320892B4AB2506B37CF08E743DB39053` and its exact default
context:

- The loaded module graph contains both required method literals:
  `start-turn-for-host` and
  `update-thread-settings-for-next-turn`.
- `app-initial-BHB6SClA.js` SHA-256 is
  `09909b1444003ea23a48d5fa973bedf48b638c6d6ef3059fb48a9f262e73513e`.
- `electronBridge.sendMessageFromView` is factually available.
- The benign `get-setting` request for the Explodex probe sentinel was actually
  dispatched through that transport and returned successfully with
  `undefined`.
- URL, ready state, message count, conversation-marker count, composer
  presence, and composer length were unchanged before and after.
- The renderer has no current `globalThis.Explodex` runtime.

This distinguishes loaded source capability, actual dispatcher transport, and
current SDK runtime state. The persisted compatibility record is therefore not
current mutation authority even though its historical capability summary names
the same required methods.

## Stop Classification

The blocker is a combined **stale persisted ownership plus stale compatibility
authority** classification:

1. Current public state parsing does not accept the historical `state.json`.
2. The public `dev status` reports `dev.root-invalid` /
   `nonempty_unowned_root`.
3. Persisted PID/start/target/context do not identify the running process or
   either current target.
4. Compatibility is `unproven` for the current CLI SDK runtime.
5. The factual signed-in renderer has no Explodex SDK runtime to host review or
   management.

## Assertion Results

The complete machine-readable table is in `flow-report.json`.

- **Pass:** `VAL-CROSS-010` supplemental live drift-refusal evidence.
- **Pending:** `VAL-DEV-017`, `VAL-DEV-024`, `VAL-CROSS-004`.
- **Blocked:** every other assertion owned by `M4-F03`.
- **Fail:** none. The environment stopped the operation before an authorized
  implementation path could run.

## Smallest Next Action

Obtain a new explicit authorization to create a fresh public-CLI-owned
development lifecycle on a fresh empty advanced root. Persist exact current
PID/start/target/context ownership, complete isolated sign-in if required, run
the public compatibility probe keyed to the then-current SDK runtime, and only
then authorize one new serial `M4-F03` live flow. Do not adopt or repair PID
`76069` in place.

## Evidence Index

- `01-cdp-target-inventory.txt`
- `02-cdp-target-json.txt`
- `03-target-id-correlation.txt`
- `05-06-contexts-snapshots-console.txt`
- `05-t1-main-renderer.png`
- `08-curl-cdp-once.txt`
- `09-raw-cdp-context-inventory.json`
- `10-loaded-source-bridge-proof.json`
- `11-loaded-module-graph-method-scan.json`
- `12-module-method-summary.json`
- `13-kernel-process-identities.json`
- `14-persisted-state-and-public-status.txt`
- `flow-report.json`
