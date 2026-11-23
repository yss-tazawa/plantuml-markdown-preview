#!/usr/bin/env node
/**
 * scripts/licenses/collect.mjs — read which third-party components the VSIX ships
 *
 * Reads only what was built and shipped, without the network:
 *   - the esbuild metafiles → the npm packages bundled into dist/extension.js and
 *     dist/scroll-sync-webview.js (written by esbuild.js to .licenses/)
 *   - mermaid.min.js.map, and the maps of @mermaid-js/parser it points into → the packages
 *     baked into dist/mermaid.min.js, at the versions mermaid was built with
 *   - the Go build info inside dist/d2/d2.wasm → the Go modules and the Go version
 *
 * generate.mjs calls these functions (no intermediate file). Run directly, it prints what was
 * read. Exit 1 when the input is not what the tools expect (see CollectError).
 *
 * Run: node scripts/licenses/collect.mjs
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { D2_WASM, LEDGER, MERMAID, METAFILES, ROOT, UNVERSIONED_SOURCES } from "./config.mjs";

/** A stop: the shipped files do not match what the tools can read */
export class CollectError extends Error {}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Compare by UTF-16 code units, the same on every machine (localeCompare depends on the ICU locale) */
export const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** sha256 of a file relative to the root */
export function sha256(rel) {
  return createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
}

/** The package directory of a path: the part up to the package under the last node_modules/ */
function packageDir(path) {
  const i = path.lastIndexOf("node_modules/");
  if (i < 0) return null;
  const rest = path.slice(i + "node_modules/".length).split("/");
  const depth = rest[0].startsWith("@") ? 2 : 1;
  return path.slice(0, i) + "node_modules/" + rest.slice(0, depth).join("/");
}

/**
 * The npm packages bundled by esbuild: name, version and directory, one per name@version.
 * Built from the metafile inputs: the modules esbuild read for a bundle.
 */
export function bundledPackages() {
  const found = new Map();
  for (const rel of METAFILES) {
    const file = join(ROOT, rel);
    if (!existsSync(file)) throw new CollectError(`${rel} is missing (run npm run build first)`);
    for (const input of Object.keys(readJson(file).inputs)) {
      const dir = packageDir(input);
      if (!dir) continue;
      const pkg = readJson(join(ROOT, dir, "package.json"));
      found.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, dir });
    }
  }
  return [...found.values()].sort((a, b) => byCode(a.name, b.name) || byCode(a.version, b.version));
}

/** name@version from a pnpm store path (`.pnpm/<name with + for />@<version>[_<peer or patch>]/node_modules/<name>/…`) */
const PNPM = /\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/;

function pnpmModule(source) {
  const m = PNPM.exec(source);
  if (!m) return null;
  const [, folder, name, file] = m;
  const prefix = `${name.replace("/", "+")}@`;
  if (!folder.startsWith(prefix)) throw new CollectError(`unexpected pnpm folder ${folder} for ${name}`);
  const rest = folder.slice(prefix.length);
  return { name, version: rest.split("_")[0], patched: rest.includes("patch_hash="), file };
}

/**
 * A prebuilt bundle: a name@version with one file in the map that is not under src/, or a
 * file whose name has `.min.`. Its own map is not shipped, so what it contains comes from the
 * hand ledger.
 */
function isBundle(files) {
  return (files.length === 1 && !files[0].startsWith("src/")) || files.some((f) => f.includes(".min."));
}

/** The bundles the hand ledger describes (their contents are listed there) */
function ledgerBundles() {
  return new Set((readJson(LEDGER).bundles ?? []).map((b) => b.module));
}

/**
 * The packages baked into dist/mermaid.min.js: name, version, whether mermaid patched it,
 * and whether it is a prebuilt bundle. The parser chunks are read through the parser's own maps
 * only when every chunk the map names is in the installed parser (then it is the same build).
 */
export function mermaidPackages() {
  const mapFile = join(ROOT, MERMAID.map);
  if (!existsSync(mapFile)) throw new CollectError(`${MERMAID.map} is missing`);
  const top = readJson(mapFile).sources ?? [];
  if (top.length === 0) throw new CollectError(`${MERMAID.map} has no sources`);
  const sources = [...top];
  for (const s of top.filter((x) => x.startsWith(MERMAID.parserPrefix))) {
    const chunk = join(ROOT, MERMAID.parser, "dist", s.slice(MERMAID.parserPrefix.length));
    if (!existsSync(chunk) || !existsSync(`${chunk}.map`)) {
      throw new CollectError(`parser chunk ${s} is not in the installed @mermaid-js/parser (move its contents to the hand ledger)`);
    }
    sources.push(...(readJson(`${chunk}.map`).sources ?? []));
  }

  const modules = new Map();
  const unknown = [];
  for (const s of sources) {
    const m = pnpmModule(s);
    if (!m) {
      if (!UNVERSIONED_SOURCES.some((u) => u.pattern.test(s))) unknown.push(s);
      continue;
    }
    const id = `${m.name}@${m.version}`;
    const entry = modules.get(id) ?? { name: m.name, version: m.version, patched: m.patched, files: new Set() };
    entry.files.add(m.file);
    modules.set(id, entry);
  }
  if (unknown.length) throw new CollectError(`map sources without a version: ${unknown.slice(0, 5).join(", ")}`);

  const described = ledgerBundles();
  const parser = readJson(join(ROOT, MERMAID.parser, "package.json"));
  const list = [{ name: parser.name, version: parser.version, patched: false, bundle: false }];
  for (const [id, m] of modules) {
    const bundle = isBundle([...m.files]);
    if (bundle && !described.has(id)) throw new CollectError(`prebuilt bundle ${id} is not in the hand ledger`);
    list.push({ name: m.name, version: m.version, patched: m.patched, bundle });
  }
  return list.sort((a, b) => byCode(a.name, b.name) || byCode(a.version, b.version));
}

/** The markers Go puts around the module info in a binary (runtime/debug.modinfo) */
const MODINFO_START = Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex");
const MODINFO_END = Buffer.from("f932433186182072008242104116d8f2", "hex");

/**
 * The Go build info inside d2.wasm: the main module, the dep modules (with any replacement),
 * the build settings and the Go version. The whole block between the markers is read, so the
 * end does not depend on which setting comes last.
 */
export function goBuildInfo() {
  const wasm = readFileSync(join(ROOT, D2_WASM));
  const start = wasm.indexOf(MODINFO_START);
  const end = start < 0 ? -1 : wasm.indexOf(MODINFO_END, start);
  if (start < 0 || end < 0) throw new CollectError(`no Go build info in ${D2_WASM}`);
  const lines = wasm.toString("utf8", start + MODINFO_START.length, end).split("\n");

  const deps = [];
  const settings = {};
  let main = null;
  for (const line of lines) {
    const [kind, ...f] = line.split("\t");
    if (kind === "mod") main = { path: f[0], version: f[1] };
    else if (kind === "dep") deps.push({ path: f[0], version: f[1] });
    /* A replaced module: the code that was built is the replacement */
    else if (kind === "=>") Object.assign(deps[deps.length - 1], { path: f[0], version: f[1] });
    else if (kind === "build") {
      const i = f[0].indexOf("=");
      if (i > 0) settings[f[0].slice(0, i)] = f[0].slice(i + 1);
    }
  }
  if (deps.length === 0) throw new CollectError(`the Go build info in ${D2_WASM} lists no dep modules`);

  /* wasm has no buildinf header with the version; the runtime's version string is used */
  const versions = new Set(wasm.toString("latin1").match(/\bgo1\.\d+(?:\.\d+)?\b/g) ?? []);
  if (versions.size !== 1) throw new CollectError(`expected one Go version in ${D2_WASM}, found ${[...versions].join(", ") || "none"}`);
  return { main, deps, settings, go: [...versions][0] };
}

function main() {
  try {
    const npm = bundledPackages();
    console.log(`npm packages in the esbuild bundles (${npm.length}):`);
    for (const p of npm) console.log(`  ${p.name}@${p.version}`);
    const mermaid = mermaidPackages();
    console.log(`packages inside ${MERMAID.bundle} (${mermaid.length}):`);
    for (const p of mermaid) console.log(`  ${p.name}@${p.version}${p.bundle ? " (prebuilt bundle)" : ""}${p.patched ? " (patched by mermaid)" : ""}`);
    const go = goBuildInfo();
    console.log(`Go build info in ${D2_WASM}: ${go.main?.path} ${go.main?.version}, ${go.go}, ${go.deps.length} modules:`);
    for (const d of go.deps) console.log(`  ${d.path}@${d.version}`);
  } catch (err) {
    if (!(err instanceof CollectError)) throw err;
    console.error(`[licenses] ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
