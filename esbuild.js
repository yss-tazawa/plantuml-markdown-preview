/**
 * @module esbuild
 * @description esbuild bundle script.
 *
 * Builds two bundles:
 * 1. dist/extension.js — Extension host (Node/CJS, vscode external)
 * 2. dist/scroll-sync-webview.js — Webview scroll sync script (browser/IIFE)
 *
 * Also copies mermaid.min.js to dist/ for Webview-side rendering.
 */
'use strict';

Promise.all([
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
    }),
    require('esbuild').build({
        entryPoints: ['./src/webview/scroll-sync-webview.ts'],
        bundle: true,
        outfile: './dist/scroll-sync-webview.js',
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: false,
        sourcemap: false,
    }),
]).then(() => {
    console.log('Build complete: dist/extension.js');
    console.log('Build complete: dist/scroll-sync-webview.js');

    // Copy mermaid.min.js to dist/ for Webview-side rendering
    const fs = require('fs');
    const path = require('path');
    const src = path.join(__dirname, 'node_modules/mermaid/dist/mermaid.min.js');
    const dest = path.join(__dirname, 'dist/mermaid.min.js');
    try {
        fs.copyFileSync(src, dest);
        console.log('Copied: dist/mermaid.min.js');
    } catch (copyErr) {
        console.error('Failed to copy mermaid.min.js:', copyErr.message);
        process.exit(1);
    }
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
