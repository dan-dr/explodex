# ADR-001: Keep the plugin registry as a collection package in the monorepo

## Status

Accepted

## Date

2026-07-16, amended 2026-07-23

## Context

Explodex needs one place for its first-party plugins. One repository per plugin
would multiply CI, dependency updates, releases, and permissions without useful
isolation at the current scale.

Here, "plugin registry" means the physical, reviewable collection of plugin
source folders. It does not mean a schema library or a remote JSON index. A
machine-readable install index may be generated from the collection, but that
index is only a release artifact.

The SDK and CLI remain independent products. Plugins consume the SDK, while the
CLI builds, installs, enables, and runs them. Neither package should contain the
first-party plugin collection.

## Decision

Use one Bun workspace monorepo with this target layout:

```text
packages/
├── sdk/                         # public @explodex/sdk
├── cli/                         # public explodex command
└── plugin-registry/             # private first-party plugin collection
    ├── package.json             # collection scripts, never plugin runtime code
    ├── registry.config.ts       # publication configuration
    ├── explodex-plugin-foo/     # independent plugin workspace
    └── explodex-plugin-bar/     # independent plugin workspace
skills/
docs/
```

`packages/plugin-registry` is the plugin registry. Every direct child matching
`explodex-plugin-*` is a complete TypeScript plugin workspace with the same
shape an external author uses outside the monorepo.

- The registry package is private and orchestrates build, validation, test,
  artifact generation, and publication for all child plugins.
- Each plugin keeps its own artifact version, SDK compatibility range, README,
  optional tests, and generated install artifact.
- Plugin artifact versions are independent opaque identifiers. SemVer and
  CalVer are both valid. Registry operations compare exact version plus
  checksum and do not assume arbitrary versions can be ordered.
- SDK exports plugin APIs, runtime code, types, and testing helpers. It has no
  dependency on the plugin registry or knowledge of plugin IDs.
- CLI depends on the SDK runtime and shared artifact schemas. It does not embed
  first-party plugin payloads.
- CI publishes immutable plugin archives through GitHub Releases or another
  direct GitHub-hosted artifact path and generates the smallest practical
  `registry.json` used by the installer. There is no registry-wide plugin
  version.
- External or personal plugins may live anywhere, but use an
  `explodex-plugin-NAME/` directory with the same package contract.

The intended root workspace patterns are:

```json
{
  "workspaces": [
    "packages/sdk",
    "packages/cli",
    "packages/plugin-registry",
    "packages/plugin-registry/explodex-plugin-*"
  ]
}
```

Implementation must verify this one layout empirically with the repository's
pinned Bun version. If Bun rejects it, simplify immediately to one root-owned
workspace layout. Do not ship or document two registry layouts.

## Boundary enforcement

1. Plugin source imports only published `@explodex/sdk` exports and its declared
   dependencies.
2. A plugin may not import CLI internals, registry orchestration code, another
   plugin, or a relative path into `packages/sdk`.
3. Registry validation consumes plugin package metadata and built artifacts,
   not plugin implementation modules.
4. CLI installation consumes the generated checksummed release index and
   immutable artifacts, not the registry source tree. The trust root is the
   canonical GitHub repository or release URL over HTTPS; checksums pin bytes
   but do not authenticate a publisher. Index or artifact signing is deferred.
5. SDK and CLI package tarballs contain no `explodex-plugin-*` payloads.
6. The installer schema is designed with the installer and adds only fields an
   implemented operation needs.

## Alternatives considered

### One repository per plugin

Rejected for first-party plugins. It adds release and coordination overhead.
External authors may still choose separate repositories.

### Put plugin folders inside SDK

Rejected. The SDK is the stable authoring/runtime contract, not a product
collection. Adding a plugin must not publish a new SDK.

### Put plugin folders inside CLI

Rejected. The CLI is tooling and runtime control. Its npm package must remain
small and must not execute or ship every first-party plugin.

### Separate plugin-registry repository

Rejected for now. A monorepo lets an SDK change and the dependent plugins land
atomically while packed-package tests preserve the real distribution boundary.

## Consequences

- `packages/plugin-registry/` is immediately understandable as the plugin
  collection.
- One CI workflow validates every first-party plugin against SDK changes.
- Plugin releases can advance independently, with their chosen version scheme,
  without separate repositories.
- A generated install index can be published without redefining the registry.
- GitHub-only distribution avoids a marketplace service or custom backend.
- Practical package-boundary tests are required; a packed external-fixture gate
  may be added later if hidden monorepo coupling becomes a demonstrated issue.
