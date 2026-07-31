# Development-instance authentication

Status: implementation probe, not a migration gate

Architecture decision: [one-shot runtime and isolated development](./decisions/002-one-shot-runtime-plugin-activation-and-sdk-development.md)

## Goal

Make the isolated development ChatGPT instance convenient to use, ideally with
the user's existing login, without sharing the main instance's live mutable
profile or `CODEX_HOME`.

Authentication convenience must not block the ChatGPT-only relaunch. A
persistent one-time sign-in in the isolated development profile is an accepted
fallback.

## Required isolation

Every approach must preserve these boundaries:

- separate writable Chromium/Electron user-data directory;
- separate writable `CODEX_HOME`;
- no symlinked mutable databases, WAL files, locks, or session stores;
- no credentials in arguments, process metadata, Explodex state, or logs;
- no modification of the installed ChatGPT bundle.

Do not copy a whole live browser profile or whole `CODEX_HOME` while main is
running. Do not make both processes write the same credential store.

## Preferred order

1. Inventory the minimum current-build account state used by the ChatGPT shell
   and Codex app server.
2. Test whether a consistent copy or short-lived projection into the isolated
   profile produces a usable login.
3. Keep only the minimum files or token material proven necessary. Document
   lifetime, permissions, refresh behavior, revocation, cleanup, and failure.
4. Verify both processes can run, refresh, restart independently, and sign out
   without corrupting or unexpectedly logging out the other.
5. If safe copy/projection is unreliable, prompt once for interactive sign-in
   and persist that independent dev login.
6. If auth is still unavailable, allow structural and unauthenticated testing
   and report authenticated live verification pending.

Current evidence from older builds identified ChatGPT tokens under
`~/.codex/auth.json` and account databases under
`~/Library/Application Support/Codex`. That inventory may be stale and must be
rechecked against installed build 5628 before any copying behavior is shipped.

## Acceptance

The dev workflow is acceptable when either:

- safe automatic login reuse works with isolated writable state; or
- one-time interactive sign-in works in the persistent dev profile.

Failure to achieve zero-interaction projection does not block implementation.
Sharing live mutable profile state remains forbidden even if it appears to work
in a short test.
