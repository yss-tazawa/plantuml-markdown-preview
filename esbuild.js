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
        external: ['vscode', '@terrastruct/d2'],
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

    // Copy D2 Wasm + worker files to dist/d2/ for runtime import
    const d2Dest = path.join(__dirname, 'dist/d2');
    try {
        fs.mkdirSync(d2Dest, { recursive: true });
        const d2Src = path.join(__dirname, 'node_modules/@terrastruct/d2/dist/node-esm');
        const d2Files = fs.readdirSync(d2Src);
        for (const f of d2Files) {
            fs.copyFileSync(path.join(d2Src, f), path.join(d2Dest, f));
        }
        // Write a package.json with "type": "module" so Node.js treats
        // the D2 .js files (and Worker script) as ESM.
        fs.writeFileSync(path.join(d2Dest, 'package.json'), '{"type":"module"}\n');
        console.log(`Copied: dist/d2/ (${d2Files.length} files + package.json)`);
    } catch (copyErr) {
        console.error('Failed to copy D2 files:', copyErr.message);
        process.exit(1);
    }

    console.log('Build complete: dist/extension.js, dist/scroll-sync-webview.js');
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
