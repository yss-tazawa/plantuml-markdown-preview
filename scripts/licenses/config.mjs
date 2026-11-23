/**
 * scripts/licenses/config.mjs — where the license tools read and write
 *
 * collect.mjs reads the shipped files listed here and generate.mjs writes the lists into
 * third-party-licenses/. Paths are relative to the repository root.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT_DIR = join(ROOT, "third-party-licenses");
/** Texts taken by `--fetch` (npm tarballs, Go module zips, upstream files); committed */
export const TEXTS_DIR = join(OUT_DIR, "texts");

/** esbuild metafiles written by esbuild.js (one per bundle) */
export const METAFILES = [".licenses/meta-extension.json", ".licenses/meta-webview.json"];

/** The hand ledger (components a machine cannot read) and the record of `--fetch` */
export const LEDGER = join(ROOT, "scripts/licenses/embedded.json");
export const FETCHED = join(ROOT, "scripts/licenses/fetched.json");

/**
 * Files that esbuild.js copies into dist/ without bundling, and the npm package each comes
 * from. They are listed with the npm packages (the package's own license covers them).
 * generate.mjs warns when a listed file is not in the build or dist/d2/ holds a file not listed.
 */
export const COPIED = [
  { pkg: "mermaid", files: ["dist/mermaid.min.js"] },
  { pkg: "katex", files: ["dist/katex.min.css", "dist/fonts/"] },
  {
    pkg: "@terrastruct/d2",
    /* node-esm/worker.js is copied as d2-worker.js; the seven files belong to one d2 version */
    files: [
      "dist/d2/chunk-ctcfg68w.js",
      "dist/d2/d2.wasm",
      "dist/d2/elk.js",
      "dist/d2/index.js",
      "dist/d2/setup.js",
      "dist/d2/wasm_exec.js",
      "dist/d2/d2-worker.js",
    ],
  },
];

/** mermaid's prebuilt bundle, its source map, and the parser package the map points into */
export const MERMAID = {
  bundle: "dist/mermaid.min.js",
  map: "node_modules/mermaid/dist/mermaid.min.js.map",
  parser: "node_modules/@mermaid-js/parser",
  /* The map names the parser by a workspace path without a version */
  parserPrefix: "../../parser/dist/",
};

/** The Go program inside d2 */
export const D2_WASM = "dist/d2/d2.wasm";

/** Where esbuild.js copies d2, and the files there that are the extension's own */
export const D2_DIR = "dist/d2";
/* worker.js is src/d2-worker.mjs; package.json marks the folder as ES modules */
export const D2_OWN = ["dist/d2/worker.js", "dist/d2/package.json"];

/**
 * Map sources without an npm name@version that are not third-party packages, or whose
 * components the hand ledger lists. Any other such source stops collect.mjs.
 */
export const UNVERSIONED_SOURCES = [
  { pattern: /^\.\.\/src\//, owner: "mermaid itself" },
  { pattern: /^\.\.\/\.\.\/parser\/dist\/(chunks\/mermaid-parser\.core\/[\w-]+|mermaid-parser\.core)\.mjs$/, owner: "@mermaid-js/parser (read through its own maps)" },
  { pattern: /^\.\.\/\.\.\/\.\.\/src\//, owner: "@mermaid-js/parser itself" },
  { pattern: /^webpack:\/\/LIB\/(src|webpack)\//, owner: "vscode-uri (hand ledger)" },
  { pattern: /^webpack:\/\/LIB\/node_modules\/path-browserify\//, owner: "path-browserify (hand ledger)" },
];
