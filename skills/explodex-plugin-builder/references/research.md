# Public-surface research

Research one V1 plugin against the published `@explodex/sdk` contract.

## Allowed evidence

- [SDK API](sdk-api.md) and the package's exported TypeScript declarations.
- Existing TypeScript workspaces under `packages/plugin-registry/`.
- Generated artifact validation and public CLI machine output.
- Exact live observations returned by `explodex --json plugin develop`.

Private host extraction, minified renderer identifiers, direct CDP evaluation,
repository injectors, and host patching are not authoring contracts.

## Workflow

1. Identify the required `PluginApi` capability.
2. Confirm its exact type and lifecycle in the SDK API.
3. Find one first-party workspace using the same capability.
4. Add a model or behavior test before host work.
5. Validate, build, and package through the public CLI.
6. Use isolated development only when static evidence cannot prove behavior.

If the public API cannot express the feature, report that boundary. Do not
reach through private globals as a workaround.
