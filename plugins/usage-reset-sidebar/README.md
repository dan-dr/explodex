# Usage & Resets Sidebar

## Purpose

Show a compact, view-only usage and reset-credit status row above Settings in the Codex sidebar.

## Implementation

The plugin uses `Explodex.http.get` through Codex's authenticated fetch bridge:

- `GET /wham/usage`
- `GET /wham/rate-limit-reset-credits`

It polls every 60 seconds and refreshes on `account/rateLimits/updated`.

## Safety

The HTTP wrapper only allows GET paths under `/wham/`, blocks path traversal, and blocks any path containing `consume`. The plugin never redeems reset credits.

## Lifecycle

- Teardown clears polling, aborts in-flight refreshes, removes bridge/sidebar subscriptions, closes the popover, and removes the sidebar row.
- A scoped mutation observer remounts the row if Codex rerenders the sidebar after the initial SDK `waitFor("sidebar")` callback.
- Resize and scroll listeners keep the popover positioned against the current sidebar button.

## Risks

- Response shapes are private and can change.
- The compact label is dense by design; if Codex adds a native usage widget, this should defer to it.

## Verify

1. Launch with `npm run launch`.
2. Confirm the sidebar row appears above Settings.
3. Click it and verify the popover opens.
4. Confirm no `/consume` request is made.
