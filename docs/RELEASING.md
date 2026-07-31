# Explodex release procedure

Releases cover two independently validated surfaces:

- the `explodex` CLI and `@explodex/sdk` npm packages;
- the first-party plugin GitHub Release, containing exactly seven immutable
  archives plus `registry.json`.

Preparing, building, testing, packaging, hashing, and rehearsing are read-only
with respect to public distribution. They do not authorize any external
mutation.

## Approval policy

Each mutation needs explicit approval for its exact target immediately before
the action. Approval for one row does not authorize another.

| Gate | Exact approval must identify | Mutation |
| --- | --- | --- |
| Create tag | tag name and commit SHA | `git tag -a ...` |
| Push commit | remote, branch, and commit SHA | `git push <remote> <branch>` |
| Push tag | remote, tag, and tag-object target | `git push <remote> <tag>` |
| Publish npm | package name, version, npm dist-tag, git SHA, and packed tarball SHA-256 | `npm publish ...` |
| Create GitHub Release | repository, tag, staged `registry.json` SHA-256, and exact eight-file asset set | `gh release create ...` |

Do not infer approval from release preparation, a prior release, a request to
"finish," or approval of another row. Never create, move, delete, recreate, or
push a tag without the corresponding current approval.

## 1. Prepare the release candidate

Start from a clean, current `main` and confirm CI is green. Choose `vX.Y.Z`,
update `CHANGELOG.md`, and update the package versions that are part of the
candidate. Preserve contributor acknowledgements.

```sh
bun install --frozen-lockfile
bun run build:npm
bun run checkTs
bun run validate
npm pack --dry-run --json ./packages/sdk --cache /tmp/explodex-sdk-npm-cache
npm pack --dry-run --json ./packages/cli --cache /tmp/explodex-cli-npm-cache
```

Review the packed file list. Produce the actual npm tarball in a disposable
directory and record its SHA-256. Confirm the repository has no unexpected
generated diff.

The public CLI has no `explodex release` command group. Use the repository
staging and publication scripts documented below.

## 2. Build the seven plugin archives

Run tests and TypeScript checks for the physical registry workspace:

```sh
bun run --cwd packages/plugin-registry test
bun run --cwd packages/plugin-registry typecheck
```

For every direct `packages/plugin-registry/explodex-plugin-*` workspace:

```sh
explodex plugin validate /absolute/path/to/workspace
explodex plugin build /absolute/path/to/workspace
explodex plugin package /absolute/path/to/workspace \
  --output /absolute/path/to/archives
```

Run `explodex plugin artifact validate` on each archive. The set must contain
exactly these IDs:

1. `command-menu-threads`
2. `effort-shortcuts`
3. `feature-flags-playground`
4. `project-colors`
5. `project-pins`
6. `toggle-autoscroll`
7. `usage-reset-glance`

Commit reviewed first-party `dist/` generations with their source. New `dist/`
paths are root-ignored, so force-stage only the exact generated files after
review. Never hand-edit a generated bundle, source map, manifest, checksum, or
generation receipt.

## 3. Deterministically stage the registry release

Use a new or empty output directory:

```sh
bun run --cwd packages/plugin-registry registry:stage -- \
  --artifact-dir /absolute/path/to/archives \
  --output-dir /absolute/path/to/release-staging \
  --release-tag vX.Y.Z
```

The staging command validates archive identities and digests, generates
byte-stable fixed-key `registry.json`, verifies immutable release URLs, and
atomically publishes exactly eight files to the staging directory. Record the
reported `registrySha256` and independently review the exact filenames.

Re-run staging from the same inputs in a second empty directory and compare the
generated registry bytes and artifact hashes. A mismatch blocks release.

## 4. Commit and CI

Create the release commit with the repository-required commit helper. Do not
push yet. Record the resulting commit SHA and re-run the candidate checks on
that exact commit.

Ask for the **push-commit gate** naming `origin`, `main`, and the exact SHA.
Only after approval:

```sh
git push origin main
```

Wait for CI on that exact SHA to pass.

## 5. Tag

Ask for the **create-tag gate** naming `vX.Y.Z` and the exact release commit
SHA. Only after approval:

```sh
git tag -a vX.Y.Z <release-commit-sha> -m "vX.Y.Z"
```

Verify the local tag target. Then ask separately for the **push-tag gate**
naming `origin`, `vX.Y.Z`, and its target. Only after approval:

```sh
git push origin vX.Y.Z
```

## 6. Publish npm

Ask for a separate **npm gate** for each package, naming the package, version,
git SHA, npm dist-tag, and packed tarball SHA-256. Only after approval, publish
the reviewed candidate from its package directory:

```sh
npm publish ./packages/sdk --provenance --access public --tag <latest-or-next>
npm publish ./packages/cli --provenance --access public --tag <latest-or-next>
```

Verify the registry version, `gitHead`, dist-tag, and provenance attestation.
If the version already exists, accept it only when `gitHead` matches the exact
release SHA. npm versions are immutable.

## 7. Create the GitHub Release and registry

Ask for the **GitHub Release gate** naming the repository, tag, staged
`registry.json` SHA-256, and exact eight filenames. Only after approval, pass
that exact digest to the guarded publication script:

```sh
bun run --cwd packages/plugin-registry registry:publish -- \
  --staging-dir /absolute/path/to/release-staging \
  --release-tag vX.Y.Z \
  --approval <registry-json-sha256>
```

The script revalidates the complete staging directory and rejects an approval
that differs from the staged registry digest before it invokes
`gh release create`.

Verify the release title, prerelease/latest status, `registry.json`, all seven
archives, and download-time hashes.

## Release candidate workflow

`.github/workflows/release.yml` is manual and read-only. It checks out an
existing immutable tag, runs the full gate, dry-packs both npm packages, rebuilds
all seven plugin archives, and requires the staged `registry.json` SHA-256 to
equal its explicit input. It has `contents: read` and cannot publish npm, create
a tag, push a commit, or create a GitHub Release.

Public mutations remain the separate local approval gates above.

## Recovery

### Failure before any public publication

Fix forward on `main`, rebuild every affected candidate byte, and repeat all
checks. A local unpublished tag may be deleted only with explicit approval.
Deleting a remote tag is a separate destructive push and requires explicit
approval naming that tag.

### npm succeeded, GitHub Release failed

Do not move or delete the tag and do not republish the npm version. Repair the
GitHub Release path using the same tag and exact staged assets after a new
GitHub Release approval.

### GitHub Release succeeded, npm failed

Do not replace release assets silently. Fix the npm path and request a fresh npm
approval for the unchanged candidate, or publish a new version if candidate
bytes must change.

### Wrong or compromised release

Never overwrite a published version or reuse its tag. Deprecation, revocation,
release deletion, or remote-tag deletion are destructive external actions and
each requires explicit user approval. Publish corrected bytes under a new
version and tag.
