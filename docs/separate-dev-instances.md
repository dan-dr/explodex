# Separate ChatGPT development instances

Status: lifecycle implemented; broader main-apply workflow remains staged

Architecture decision: [one-shot runtime and isolated development](./decisions/002-one-shot-runtime-plugin-activation-and-sdk-development.md)

## Purpose

Plugin work may begin inside the ChatGPT instance hosting the authoring
conversation. Safe dynamic injection is allowed there. Restart, reload,
navigation, close, and stop are not.

Explodex therefore uses two ChatGPT process roles without a persistent external
supervisor:

| Role | Purpose | Lifecycle owner |
|---|---|---|
| Main/authoring | Conversation plus safe dynamic plugin tests | User; never restart/stop through plugin development |
| Development | Reload, restart, app-start, SDK-runtime, and isolated tests | Explicit one-shot Explodex lifecycle operations |

The development process uses the installed ChatGPT.app as a read-only
executable source. Its mutable profile, `CODEX_HOME`, Explodex state, logs, and
CDP port are isolated.

## Process model

Normal lifecycle operations start, inspect, inject, restart, stop, or focus the
development process and then exit. ChatGPT keeps running independently.

An explicitly invoked plugin development command may remain in the foreground
while it watches selected plugin and SDK source. Its CDP connection, rebuilds,
and explicit-restart reconnection exist only for that operation. It is not a
general session manager and does not reconnect after unrelated events once it
has exited.

## Safety invariants

1. A ChatGPT process is protected unless Explodex proves it created that exact
   process as a development instance.
2. Main may receive dynamic inject, unload, load, and interaction tests. Plugin
   development never restarts, reloads, navigates, closes, or stops main.
3. Unknown processes, ports, missing state, stale state, and ambiguous targets
   fail closed.
4. Restart and stop apply only after the development ownership checks pass in
   the current operation.
5. CDP operations use the requested role, recorded port, and selected renderer.
   They never fall back to the first reachable ChatGPT renderer.
6. Hot unload/load is preferred. Full app restart is limited to the exact owned
   development process.
7. Termination uses CDP `Browser.close` on the dev port or a signal to the exact
   verified PID. Never quit ChatGPT globally by name or bundle identifier.
8. No automatic `SIGKILL`. A graceful-stop timeout is reported for user
   decision.
9. After evidence is collected, return focus to main and inject the final
   hot-safe artifact. Ask before any result that cannot be applied safely.
10. Structural work may continue when live targets are unavailable, but live
    verification remains explicitly pending.

## Persistent instance layout

```text
~/.explodex/dev/<instance-id>/
├── electron-user-data/
├── codex-home/
├── explodex-state/
├── logs/
│   ├── app.stdout.log
│   └── app.stderr.log
└── state.json
```

Use canonical real paths. The default instance ID is `plugin-dev`; the default
CDP port is `9444`. Provide one advanced profile-root override rather than
multiple equivalent settings.

## Recorded state

Each lifecycle operation writes `state.json` atomically with mode `0600`. It
contains no tokens, cookies, full environment dump, or plugin source.

```ts
type DevInstanceStatus = "starting" | "ready" | "stopping" | "stale" | "failed";

type DevInstanceState = {
  schemaVersion: 1;
  instanceId: string;
  role: "development";
  status: DevInstanceStatus;
  appPath: string;
  executablePath: string;
  pid: number;
  processStartedAt: string;
  launchMarker: string;
  electronUserDataPath: string;
  codexHomePath: string;
  explodexStatePath: string;
  cdpHost: "127.0.0.1";
  cdpPort: number;
  targetId: string | null;
  appVersion: string;
  appBuild: string;
  startedAt: string;
  updatedAt: string;
};
```

Do not record a supervisor/controller PID because none exists after a one-shot
operation exits. Last-good development artifacts belong to the active plugin
development command or build output, not automatic recovery state.

## Ownership checks

Before restart or stop, the current operation verifies:

1. `state.json` parses against the current schema.
2. Role is `development` and instance ID matches the requested directory.
3. The PID is alive and its process start time matches the record.
4. The executable is the recorded ChatGPT executable inside the recorded
   read-only bundle.
5. Launch arguments or another proven current-build marker identify the
   isolated development launch and recorded CDP port.
6. The recorded isolated paths are descendants of the requested instance root
   and are not the normal ChatGPT profile or `~/.codex`.
7. The CDP endpoint and expected renderer belong to the recorded development
   launch. Use the existing safe ownership mechanism unless current-build tests
   prove it insufficient.
8. If main identity is known, development PID and target differ from it.

Any mismatch marks state stale, emits diagnostics, and performs no signal or
restart. PID equality alone is insufficient because macOS reuses PIDs.

## Launch contract

The development operation launches the installed inner executable directly so
macOS does not route to the already running main app. Phase 0 determines the
smallest current-build inputs that actually isolate the profile.

Candidate inputs to verify, not permanent requirements:

```text
CODEX_ELECTRON_USER_DATA_PATH=<real isolated profile>
CODEX_HOME=<real isolated codex home>
EXPLODEX_HOME=<real isolated Explodex state>
/Applications/ChatGPT.app/Contents/MacOS/ChatGPT
--remote-debugging-port=<recorded port>
<one proven ownership marker if tolerated>
```

Retain `--user-data-dir`, environment overrides, or other flags only when the
build-5628 probe proves they have distinct necessary semantics. Do not keep
redundant isolation knobs.

Before reporting ready, the operation verifies process identity, waits for the
local CDP endpoint, selects one expected `app://-/index.html` target, records
its target ID, injects when requested, and exits.

Sparkle suppression and special update recovery are deferred. If the installed
bundle changes, a later operation re-probes compatibility before injection.

## Authentication

Dev auth is a convenience problem, not a migration gate. Mutable profile and
`CODEX_HOME` isolation remain mandatory.

Preferred order:

1. Safely copy or project the minimum existing login state if current-build
   tests prove it works without sharing live mutable stores.
2. Otherwise use one persistent interactive sign-in in the dev profile.
3. If auth is unavailable, continue structural or unauthenticated testing and
   report authenticated live verification pending.

Never share the main browser profile or `CODEX_HOME`, symlink mutable stores,
or expose credentials in arguments, state, or logs. See
[dev-auth-projection.md](./dev-auth-projection.md).

## Operation semantics

The public lifecycle surface is:

```bash
explodex dev ensure   # normal idempotent entry point
explodex dev status   # read-only health and next action
explodex dev start    # strict stopped-to-ready transition
explodex dev recover  # explicit partial-state recovery
explodex dev restart  # one exact stop followed by one launch
explodex dev stop     # exact owned process only
```

There is no daemon, watchdog, or automatic restart loop. `ensure` performs one
special bounded recovery: when the recorded process is independently dead or
its PID start identity was reused, and port `9444` is free, it commits stopped
state and launches once. Live or ambiguous partial ownership still requires
explicit recovery and never causes a signal.

| Operation | Required behavior |
|---|---|
| Ensure development | Return verified ready state or start the requested instance; never adopt an unrecorded process |
| Start development | Create isolated paths, launch, verify process and CDP, write state, then exit |
| Status | Read-only state, process, port, target, version, and ownership report |
| Inject development | Validate artifacts, verify identity again, inject into recorded dev target, then exit |
| Restart development | Verify ownership, close/signal exact dev process, wait, relaunch same isolated instance, reconnect for this operation, inject requested artifacts, then exit |
| Stop development | Verify ownership, close/signal exact dev process, wait, retain logs and state, then exit |
| Focus main | Activate the user-owned main app without navigating, reloading, or closing either renderer |
| Plugin development watch | Stay foreground while selected sources are watched; use main only for dynamic operations and development for disruptive work |

## Plugin-builder workflow

1. Treat the current ChatGPT session as protected.
2. Build and validate before mutating a renderer.
3. When the exact main CDP target is available and the plugin is dynamic,
   inject/unload/load there without lifecycle mutation.
4. If restart, reload, app-start behavior, SDK replacement, or isolation is
   required, ensure the exact development instance and continue there.
5. Persist evidence before an explicit dev restart and restart only the proven
   development process.
6. Collect snapshots, console errors, bridge results, and runtime evidence from
   the named target.
7. Return focus to main and apply the final hot-safe plugin artifact.
8. If auth/UI interaction, ambiguous identity, SDK design, or a non-hot result
   needs input, preserve work and prompt the user with the exact blocker.
9. Report in the original conversation. Leaving or stopping dev is an explicit
   operation, not automatic cleanup.

The skill must not use generic app quit commands or restart the app containing
its own session. A running plugin development watch is bounded to the current
task and must end when that task ends.

## Failure behavior

| Condition | Behavior |
|---|---|
| Dev auth unavailable | Keep main untouched; report authenticated verification pending |
| Dev process absent | Start a new owned development instance |
| State missing but port occupied | Refuse adoption; report foreign port |
| Recorded PID dead | Mark stale; allow an explicit fresh start |
| PID alive but identity differs | Mark stale; never signal it |
| Renderer changes during explicit restart/reload | Re-select only within the recorded dev port for that operation |
| Renderer changes after all operations exit | Do nothing; reconnect only on the next explicit operation |
| Build fails | Leave prior live artifact untouched; show diagnostics |
| Plugin requires restart | Restart only the verified development instance |
| Final main apply requires restart | Stage artifact and ask; keep main running |
| Manual auth, permission, or UI step | Keep both apps running; prompt the user |
| Focus activation fails | Leave both renderers unchanged and report nonfatal failure |

## Verification matrix

Implementation is complete when repeatable tests prove:

1. Main remains alive through dev start, injection, explicit reload, restart,
   and stop.
2. Restart/stop refuses main even though both processes use the same bundle.
3. Foreign ports and stale/reused PIDs never cause a signal.
4. Injection reaches only the requested development target.
5. A failed build leaves the previous live artifact untouched.
6. Dynamic main testing restarts neither app.
7. Restart-required testing restarts only development.
8. The lifecycle command exits while ChatGPT continues.
9. No background supervisor, socket, or reconnect loop remains.
10. Focus returns to main or fails without altering either renderer.
11. A plugin can be authored from a normal ChatGPT session through the same
    published workflow used by the Explodex maintainer.
