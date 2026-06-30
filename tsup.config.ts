import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  clean: true,
  // Externalize package.json `dependencies` (tsup default) — they're installed
  // when the package is `npx`'d / installed. We bundle only our own source,
  // which avoids ESM/CJS bundling pitfalls (commander, ink devtools, parcel deps).
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);",
  },
  splitting: false,
  minify: false,
});
