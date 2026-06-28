# Explodex Release Procedure

This document outlines the step-by-step procedure for releasing new versions of Explodex to npm and GitHub.

---

## Operator Release Procedure

Follow these steps to release a new version of Explodex.

### 1. Pre-release Checks
1. Start from a clean and up-to-date `main` branch:
   ```bash
   git checkout main
   git pull origin main
   git status # verify clean working directory
   ```
2. Confirm that the Continuous Integration (CI) status is green on GitHub for the latest commit on `main`.

### 2. Version and Changelog Preparation
3. Choose the next version according to SemVer rules (e.g., `v0.2.2`).
4. Update `CHANGELOG.md`:
   - Move release notes from the `## [Unreleased]` section into a new dated version section:
     ```markdown
     ## [X.Y.Z] - YYYY-MM-DD
     ```
   - Preserve all contributor acknowledgements as required.
5. Update `package.json`:
   - Change the `"version"` field to match the selected version (e.g., `"version": "0.2.2"`).

### 3. Local Verification
6. Run local validation and package packaging checks:
   ```bash
   # Ensure dependencies are locked and correct
   bun install --frozen-lockfile

   # Run local validation suite (checks lints, types, tests, builds the injector)
   bun run validate

   # Verify the release metadata and changelog
   bun run release:check -- vX.Y.Z

   # Perform a dry-run npm pack to confirm contents
   npm pack --dry-run --json --cache /tmp/explodex-npm-cache
   ```

### 4. Release Commit & Tag
7. Commit only the release metadata changes (`package.json`, `bun.lock`, `CHANGELOG.md`, `lib/cdp-inject.mjs`):
   ```bash
   git add package.json bun.lock CHANGELOG.md lib/cdp-inject.mjs
   git commit -m "chore(release): vX.Y.Z"
   ```
   > [!NOTE]
   > Use the repository-required `committer` helper if configured.
8. Push the release commit to the remote repository:
   ```bash
   git push origin main
   ```
9. Wait for the CI workflow run to complete successfully on GitHub.
10. Create an annotated git tag on the release commit:
    ```bash
    git tag -a vX.Y.Z -m "vX.Y.Z"
    ```
11. Push the tag to GitHub:
    ```bash
    git push origin vX.Y.Z
    ```

### 5. Post-Release Verification
12. Observe the automated **Release** workflow on GitHub Actions.
13. Confirm publication on npm:
    - Version is visible.
    - Correct distribution tag (stable goes to `latest`, prerelease goes to `next`).
    - NPM provenance attestation is present.
14. Confirm the GitHub Release:
    - Curated notes are prepended.
    - Title is `vX.Y.Z`.
    - Prerelease status is correctly flagged.
15. **Never move, recreate, or reuse a published version tag.**

---

## Recovery Guidance

If something goes wrong during the release flow, follow this guidance.

### Scenario A: Failure BEFORE npm publish
If the Release workflow fails before running the npm publish step (e.g., git check fails or validation fails):
1. Fix the issues on the `main` branch.
2. If necessary, delete the unpublished local/remote tag:
   ```bash
   git tag -d vX.Y.Z
   git push --delete origin vX.Y.Z
   ```
3. Commit the fix and follow the release procedure again to push a new tag.

### Scenario B: npm published but GitHub Release failed
If npm publication succeeds but the GitHub Release creation fails:
1. Do NOT delete or modify the git tag.
2. Go to the failed GitHub Action run and trigger a rerun.
3. The workflow's idempotency check will detect that version `X.Y.Z` with matching `gitHead` is already on npm, skip the publish step, and create the GitHub Release.

### Scenario C: Wrong npm package contents
Since published npm versions are immutable:
1. Do NOT try to overwrite the tag or publish the same version.
2. Deprecate the bad version on npm:
   ```bash
   npm deprecate explodex@X.Y.Z "Version contains issues, please use X.Y.Z+1"
   ```
3. Publish a new patch release (e.g., `X.Y.Z+1`) with the corrections.

### Scenario D: Compromised release
If a release is compromised (e.g., leaked secrets or incorrect access):
1. Deprecate or revoke the version through the npm registry immediately.
2. Never reuse or overwrite the tag. Create a new secure version.
