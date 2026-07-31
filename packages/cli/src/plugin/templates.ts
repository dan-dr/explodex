import { SDK_VERSION } from "@explodex/sdk";
import { NEUTRAL_PACKAGE_VERSION } from "./types.ts";

export function packageJsonTemplate(packageName: string): string {
  const body = {
    name: packageName,
    version: NEUTRAL_PACKAGE_VERSION,
    private: true,
    type: "module",
    description: "An Explodex plugin workspace.",
    peerDependencies: {
      "@explodex/sdk": `^${SDK_VERSION}`,
    },
    devDependencies: {
      "@explodex/sdk": SDK_VERSION,
      typescript: "5.9.3",
    },
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function explodexConfigTemplate(options: {
  displayName: string;
  description: string;
}): string {
  return `import { defineConfig } from "@explodex/sdk";

export default defineConfig({
  version: "0.1.0",
  displayName: ${JSON.stringify(options.displayName)},
  description: ${JSON.stringify(options.description)},
  lifecycle: "dynamic",
});
`;
}

export function entryTemplate(): string {
  return `import { definePlugin } from "@explodex/sdk";

export default definePlugin({
  setup() {
    // Setup runs only after the runtime accepts this exact artifact identity.
  },
});
`;
}

export function readmeTemplate(options: {
  packageName: string;
  id: string;
  displayName: string;
}): string {
  return `# ${options.displayName}

Plugin ID: \`${options.id}\`

Package: \`${options.packageName}\`

## Authoring

- Artifact version, display name, description, entry, assets, and lifecycle live in \`explodex.config.ts\`.
- Plugin ID is derived from the package/folder name \`${options.packageName}\`.
- SDK compatibility comes only from \`peerDependencies["@explodex/sdk"]\`.
- \`package.json\` version is package-manager metadata and is not the artifact version.

## Commands

\`\`\`bash
explodex plugin validate
explodex plugin build
explodex plugin package
\`\`\`
`;
}

export function tsconfigTemplate(): string {
  const body = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noImplicitAny: true,
      skipLibCheck: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      rootDir: ".",
      outDir: "dist-types",
      declaration: false,
      types: [],
      // Browser plugin graph: no Node types by default.
      noEmit: true,
    },
    include: ["src/**/*.ts", "explodex.config.ts"],
    exclude: ["dist", "node_modules", "test"],
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
