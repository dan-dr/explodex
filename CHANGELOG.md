# Changelog

## [Unreleased]

## [0.2.2] - 2026-06-29
### Added
- Interactive `explodex` CLI with first-run launcher setup (`@clack/prompts`).
- GitHub Actions CI and release workflows.
- `release:check` / `release:notes` helpers and `docs/RELEASING.md`.
- Project Pins: sort pinned threads by sidebar recency labels.

### Changed
- Launch Codex via `open -a` so it keeps its own TCC identity (permission prompts no longer attributed to the terminal).
- Stop auto-quitting Codex when it is running without Explodex; prompt the user to quit first.
- Rename internal `--from-app` flag to `--launch` (`--from-app` remains a deprecated alias).
- CDP injector exits sooner once injection is idle (avoids an ~8s tail wait).
- Replace `cac` with `@clack/prompts` in the npm CLI.

## [0.2.0] - 2026-06-28
### Added
- npm-first launcher and generated macOS application.
- Normal Codex-profile launch and launcher lifecycle tests.

## [0.1.0] - 2026-06-28
### Added
- Initial Explodex SDK and bundled plugins.