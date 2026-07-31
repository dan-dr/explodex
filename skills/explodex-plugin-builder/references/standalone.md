# Standalone plugin authoring

A repository checkout is not required. Install the public `explodex` CLI and
`@explodex/sdk` package, then create a normal TypeScript workspace.

## Workflow

1. Run `explodex plugin create <workspace>`.
2. Author `src/index.ts` against the published `@explodex/sdk` types and the
   bundled [SDK API](sdk-api.md).
3. Run the public validate, build, and package commands.
4. Use `explodex --json plugin develop <workspace>` for isolated live proof.
5. Validate the final archive before install or distribution.

The CLI owns generated manifests, registration wrappers, archive identity,
installation state, and renderer mutation. Do not substitute copied templates,
standalone validators, direct state writes, or repository injectors.
