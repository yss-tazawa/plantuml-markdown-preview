/**
 * @module esbuild
 * @description esbuild bundle script.
 *
 * Bundles extension.ts + src/*.ts + node_modules/ into a single dist/extension.js.
 * - Format: CommonJS (required by VS Code extension host)
 * - Platform: Node 18
 * - External: 'vscode' (provided by the runtime)
 * - No minification / no sourcemap (easier debugging during development)
 */
'use strict';

require('esbuild').build({
    entryPoints: ['./extension.ts'],
    bundle: true,
    outfile: './dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    minify: false,
    sourcemap: false,
}).then(() => {
    console.log('Build complete: dist/extension.js');
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
