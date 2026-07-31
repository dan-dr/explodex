# @explodex/sdk

Public TypeScript authoring API and generated renderer runtime for Explodex V1
plugins.

```sh
npm install --save-dev @explodex/sdk
```

Author plugins with `definePlugin` and configuration with `defineConfig`.
Runtime capabilities are supplied only when an exact validated artifact is
activated by the Explodex CLI.

Exports:

- `@explodex/sdk` - authoring types and helpers
- `@explodex/sdk/runtime` - generated renderer runtime contract
- `@explodex/sdk/testing` - public test helpers

See the repository's `docs/sdk-api.md` for the complete API and lifecycle.
