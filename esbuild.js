/**
 * @module esbuild
 * @description esbuild bundle script.
 *
 * Builds two bundles:
 * 1. dist/extension.js — Extension host (Node/CJS, vscode external)
 * 2. dist/scroll-sync-webview.js — Webview scroll sync script (browser/IIFE)
 *
 * Also copies mermaid.min.js to dist/ for Webview-side rendering,
 * and KaTeX CSS + fonts to dist/ for math rendering.
 */
'use strict';

const pkg = require('./package.json');
const katexVersion = pkg.dependencies.katex.replace(/^[\^~>=<]*/, '');
const mermaidMajor = pkg.dependencies.mermaid.replace(/^[\^~>=<]*/, '').split('.')[0];

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
        define: {
            '__KATEX_VERSION__': JSON.stringify(katexVersion),
            '__MERMAID_MAJOR__': JSON.stringify(mermaidMajor),
        },
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

    // Copy KaTeX CSS and fonts to dist/ for math rendering
    const katexCssSrc = path.join(__dirname, 'node_modules/katex/dist/katex.min.css');
    const katexCssDest = path.join(__dirname, 'dist/katex.min.css');
    try {
        fs.copyFileSync(katexCssSrc, katexCssDest);
        console.log('Copied: dist/katex.min.css');
    } catch (copyErr) {
        console.error('Failed to copy katex.min.css:', copyErr.message);
        process.exit(1);
    }

    const katexFontsSrc = path.join(__dirname, 'node_modules/katex/dist/fonts');
    const katexFontsDest = path.join(__dirname, 'dist/fonts');
    try {
        fs.mkdirSync(katexFontsDest, { recursive: true });
        const fontFiles = fs.readdirSync(katexFontsSrc).filter(f => f.endsWith('.woff2'));
        for (const f of fontFiles) {
            fs.copyFileSync(path.join(katexFontsSrc, f), path.join(katexFontsDest, f));
        }
        console.log(`Copied: dist/fonts/ (${fontFiles.length} woff2 files)`);
    } catch (copyErr) {
        console.error('Failed to copy KaTeX fonts:', copyErr.message);
        process.exit(1);
    }

    console.log('Build complete: dist/extension.js, dist/scroll-sync-webview.js');
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
