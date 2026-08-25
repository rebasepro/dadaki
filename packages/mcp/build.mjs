/**
 * Build the publishable server: one self-contained ESM file at dist/index.js.
 *
 * Why bundle rather than ship the sources:
 *
 *  - The package is meant to be run as `npx @dadaki/mcp`, and npx installs the
 *    whole dependency tree before it runs anything. Inlining the three pure-JS
 *    runtime deps makes that a single small download instead of a tree.
 *  - The sources are TypeScript run through Node's type stripping, which needs
 *    a flag on Node < 22.18 and an `env -S` shebang to pass it. Consumers
 *    should not have to care: plain JS behind a plain `#!/usr/bin/env node`
 *    runs everywhere.
 *
 * The result has no external imports at all: the server drives an editor tab
 * the user already has open, so it launches no browser and needs no browser
 * automation library.
 */

import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = `${HERE}dist/index.js`;

await build({
    entryPoints: [`${HERE}src/index.ts`],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // The floor the package advertises in `engines`.
    target: 'node20',
    // Some dependencies are CommonJS and call `require` after bundling into an
    // ESM output, where it does not exist. This is the standard shim.
    banner: {
        js: [
            "import { createRequire as __createRequire } from 'node:module';",
            'const require = __createRequire(import.meta.url);',
        ].join('\n'),
    },
    logLevel: 'info',
});

// esbuild hoists the entry point's own shebang to the top of the output, so
// the bundle would otherwise claim to need `--experimental-strip-types`. It is
// plain JavaScript and needs no flags: swap in the ordinary one.
const lines = readFileSync(OUT, 'utf8').split('\n');
if (lines[0].startsWith('#!')) lines.shift();
writeFileSync(OUT, ['#!/usr/bin/env node', ...lines].join('\n'));

chmodSync(OUT, 0o755);

// The manifest says MIT; the tarball has to carry the text that says so. The
// licence lives at the repo root, which `files` cannot reach, so copy it in.
copyFileSync(`${HERE}../../LICENSE`, `${HERE}LICENSE`);

console.log(`[dadaki-mcp] built ${OUT}`);
