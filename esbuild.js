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

    // Copy mermaid.min.js to dist/ for Webview-side rendering
    const fs = require('fs');
    const path = require('path');
    const src = path.join(__dirname, 'node_modules/mermaid/dist/mermaid.min.js');
    const dest = path.join(__dirname, 'dist/mermaid.min.js');
    fs.copyFileSync(src, dest);
    console.log('Copied: dist/mermaid.min.js');
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
