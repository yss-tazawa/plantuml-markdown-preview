#!/usr/bin/env node
/**
 * scripts/licenses/generate.mjs — regenerate the third-party license lists
 *
 * The VSIX ships third-party code (the npm packages bundled into dist/ and copied into it, and
 * the components inside them), so it must ship their **license texts (= copyright notices)** as
 * well, not only their names and versions. Four files are generated and all are committed (so
 * changes show up in the diff):
 *   third-party-licenses/NPM-DEPENDENCIES.csv     … index of the npm packages in the esbuild
 *                                                   bundles and of the three packages esbuild.js copies
 *   third-party-licenses/NPM-LICENSES.txt         … their texts (a heading + each package's license file)
 *   third-party-licenses/EMBEDDED-COMPONENTS.csv  … index of the components inside mermaid.min.js
 *                                                   and dist/d2/, and of the Graphviz build
 *                                                   inside vendor/plantuml.jar
 *   third-party-licenses/EMBEDDED-LICENSES.txt    … their texts
 *
 * The components come from collect.mjs (what the build shipped) and from the hand ledger
 * (embedded.json). Without arguments nothing is downloaded: texts are read from node_modules
 * (same name@version only) or from third-party-licenses/texts/. `--fetch` first downloads the
 * texts that are missing there (npm tarballs, Go module zips from proxy.golang.org, upstream
 * files) and records them in fetched.json.
 *
 * Run: npm run licenses (build, then this script); npm run licenses -- --fetch
 * No dependency is added (downloads use node's fetch, archives are opened with tar).
 * Exit 1 when the collection stops, a text is missing, a license name is missing, or an
 * OR expression has no chosen license.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPackages, byCode, CollectError, goBuildInfo, mermaidPackages, sha256 } from "./collect.mjs";
import { COPIED, D2_DIR, D2_OWN, FETCHED, LEDGER, MERMAID, OUT_DIR, ROOT, TEXTS_DIR } from "./config.mjs";

/**
 * The license text of packages that ship no license file. Package name → path relative to
 * `third-party-licenses/`. The text is taken from the upstream repository at the package's npm
 * `gitHead` (source and date are in NOTICE.md).
 */
const TEXT_OVERRIDES = {
  "@terrastruct/d2": "npm-texts/terrastruct-d2.txt",
};

/**
 * Notes put in front of the license text when the shipped license file offers a choice of two
 * licenses: which one this extension uses, and the copyright notice of the package's license
 * banner. Package name (without version) → lines. The copyright lines are copied from the package
 * itself (its dist license banner, package.json author).
 */
const LICENSE_NOTES = {
  dompurify: [
    "(c) Cure53 and other contributors",
    "(as stated in the license banner of dist/purify.js; package.json author: Dr.-Ing. Mario Heiderich, Cure53)",
    "",
    "DOMPurify is offered under (MPL-2.0 OR Apache-2.0). The license file that follows offers both and",
    "contains both texts; this extension uses it under the Apache License, Version 2.0.",
    "Neither the package nor the upstream repository ships a NOTICE file.",
  ],
};

/**
 * The license name of packages whose package.json has no license field. Package name → SPDX id,
 * read from the license file the package ships.
 */
const LICENSE_NAMES = {
  khroma: "MIT",
};

/** The license chosen from an OR expression of an npm package (package name → SPDX id) */
const CHOSEN = {
  dompurify: "Apache-2.0",
};

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
/**
 * Text bytes as a string, CRLF normalized to LF so the generated files stay stable. Bytes that
 * are not UTF-8 (such as the Latin-1 licenses/ftl.txt of Freetype-Go) are read as Latin-1.
 */
function decodeText(bytes) {
  let text = bytes.toString("utf8");
  if (text.includes("\uFFFD") && !bytes.includes(Buffer.from("\uFFFD"))) text = bytes.toString("latin1");
  return text.replace(/\r\n?/g, "\n").trimEnd();
}

/** A text file as a string (see decodeText) */
const readText = (p) => decodeText(readFileSync(p));

/** One CSV cell (`"` doubled and quoted, the same form as license-checker's output) */
function cell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/** The license of a package.json (`license`, or the old `licenses` array joined with OR) */
function packageLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "";
}

/** The repository of a package.json as an https URL (the form license-checker printed) */
function packageRepository(pkg) {
  let url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
  if (/^(github:)?[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url.replace(/^github:/, "")}`;
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
}

/** The author's name, printed as the publisher (as license-checker did) */
function packagePublisher(pkg) {
  const a = pkg.author;
  if (!a) return "";
  return typeof a === "string" ? a.replace(/\s*[<(].*$/, "") : a.name ?? "";
}

/**
 * The license files directly in a package folder: names starting with LICENSE / LICENCE /
 * COPYING in any case (never a README), joined in name order when there are several.
 */
function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying)/i.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => readText(join(dir, f)))
    .join("\n\n");
}

/** The chosen license: the only one, or the one chosen from an OR expression ("" if none) */
function chosenLicense(license, chosen) {
  if (!/\bOR\b/.test(license)) return license;
  return chosen ?? "";
}

/** Every installed package by name@version (nested node_modules included) → its folder */
function installedPackages() {
  const index = new Map();
  const walk = (dir) => {
    const nm = join(dir, "node_modules");
    if (!existsSync(nm)) return;
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith(".")) continue;
      const dirs = entry.startsWith("@") ? readdirSync(join(nm, entry)).map((e) => join(nm, entry, e)) : [join(nm, entry)];
      for (const d of dirs) {
        const file = join(d, "package.json");
        if (!existsSync(file)) continue;
        const pkg = readJson(file);
        if (pkg.name && pkg.version && !index.has(`${pkg.name}@${pkg.version}`)) index.set(`${pkg.name}@${pkg.version}`, d);
        walk(d);
      }
    }
  };
  walk(ROOT);
  return index;
}

/** Where `--fetch` keeps a text, relative to `third-party-licenses/` */
function textFileName(spec) {
  const [kind, rest] = [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)];
  const at = rest.lastIndexOf("@");
  const slug = (s) => s.replace(/^@/, "").replace(/[/:]+/g, "-");
  if (kind === "npm") return `texts/npm-${slug(rest.slice(0, at))}-${rest.slice(at + 1)}.txt`;
  if (kind === "go") return `texts/go-${slug(rest.slice(0, at))}-${rest.slice(at + 1)}.txt`;
  /* url: the path of the URL (without the host and the extension) */
  const path = new URL(rest).pathname.replace(/^\//, "").replace(/\.(txt|md)$/i, "");
  return `texts/url-${slug(path)}.txt`;
}

/** Download a URL (throws on an HTTP error) */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The tar that opens both archive kinds: bsdtar. On Windows it is System32's tar.exe, called by
 * its full path because the tar first in the PATH of Git Bash is GNU tar, which cannot open a .zip.
 */
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/** Open an archive (npm .tgz or Go .zip; bsdtar reads both) into a new temporary folder */
function unpack(bytes, name) {
  const dir = mkdtempSync(join(tmpdir(), "pmp-licenses-"));
  const file = join(dir, name);
  writeFileSync(file, bytes);
  mkdirSync(join(dir, "x"));
  execFileSync(TAR, ["-xf", file, "-C", join(dir, "x")]);
  return dir;
}

/** The module path as proxy.golang.org spells it (capital letters become !lowercase) */
const goEscape = (s) => s.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

/**
 * Download one text. Returns the record for fetched.json: the text, and for an npm package also
 * the license and repository of its package.json. go: and url: texts are recorded without them,
 * because one text (such as an SPDX license text) can serve several components; those rows take
 * their license and repository from the hand ledger. `info.files` names the files to take from a
 * Go module (default: the license files of its root folder).
 */
async function fetchText(spec, info) {
  const kind = spec.slice(0, spec.indexOf(":"));
  const rest = spec.slice(kind.length + 1);
  const out = textFileName(spec);
  let text;
  let record = {};
  if (kind === "url") {
    text = decodeText(await download(rest));
  } else {
    const at = rest.lastIndexOf("@");
    const [name, version] = [rest.slice(0, at), rest.slice(at + 1)];
    const url = kind === "npm"
      ? `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`
      : `https://proxy.golang.org/${goEscape(name)}/@v/${goEscape(version)}.zip`;
    const dir = unpack(await download(url), kind === "npm" ? "p.tgz" : "m.zip");
    try {
      const root = kind === "npm" ? join(dir, "x", "package") : join(dir, "x", `${name}@${version}`);
      if (kind === "npm") {
        const pkg = readJson(join(root, "package.json"));
        record = { license: packageLicense(pkg), repository: packageRepository(pkg) };
      }
      text = info.files ? info.files.map((f) => readText(join(root, f))).join("\n\n") : licenseFiles(root);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!text) throw new Error(`${spec}: no license file found`);
  mkdirSync(TEXTS_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, out), `${text}\n`, "utf8");
  return { ...record, text: out };
}

/** The npm packages: those in the esbuild bundles and the three that esbuild.js copies */
function npmRows() {
  const packages = bundledPackages();
  for (const { pkg } of COPIED) {
    const dir = join("node_modules", pkg);
    const json = readJson(join(ROOT, dir, "package.json"));
    /* katex is both bundled (its JS) and copied (its CSS and fonts): one row */
    if (!packages.some((p) => p.name === json.name && p.version === json.version)) packages.push({ name: json.name, version: json.version, dir });
  }
  return packages.map(({ name, version, dir }) => {
    const pkg = readJson(join(ROOT, dir, "package.json"));
    const override = TEXT_OVERRIDES[name];
    const license = packageLicense(pkg) || LICENSE_NAMES[name] || "";
    return {
      id: `${name}@${version}`,
      name,
      license,
      chosen: chosenLicense(license, CHOSEN[name]),
      repository: packageRepository(pkg),
      publisher: packagePublisher(pkg),
      text: override ? readText(join(OUT_DIR, override)) : licenseFiles(join(ROOT, dir)),
    };
  }).sort((a, b) => byCode(a.id, b.id));
}

/**
 * The repository of a Go module: https:// and the module path without the major version suffix
 * (`/v2` and so on), which names no folder of the repository (github.com/alecthomas/chroma/v2 →
 * https://github.com/alecthomas/chroma).
 */
const goRepository = (path) => `https://${path.replace(/\/v\d+$/, "")}`;

/**
 * The components inside the shipped files, each with the spec of its text: npm packages baked
 * into mermaid.min.js, the Go modules and Go itself in d2.wasm, and the hand ledger's entries.
 */
function embeddedRows(ledger, go) {
  const rows = [];
  for (const p of mermaidPackages()) {
    rows.push({
      id: `${p.name}@${p.version}`, name: p.name, container: MERMAID.bundle, patched: p.patched,
      text: `npm:${p.name}@${p.version}`, info: {},
    });
  }
  for (const d of go.deps) {
    const entry = ledger.go[d.path] ?? {};
    rows.push({
      id: `${d.path}@${d.version}`, name: d.path, license: entry.license ?? "", chosen: entry.chosen,
      repository: goRepository(d.path), container: "dist/d2/d2.wasm", note: entry.note,
      text: `go:${d.path}@${d.version}`, info: { files: entry.files },
    });
  }
  const std = ledger.stdlib;
  rows.push({
    id: `${std.name}@${go.go}`, name: std.name, license: std.license, repository: std.repository,
    container: "dist/d2/d2.wasm", text: std.text.replace("{go}", go.go), info: {},
  });
  for (const c of ledger.components) {
    rows.push({
      id: c.version ? `${c.name}@${c.version}` : c.name, name: c.name, license: c.license, chosen: c.chosen,
      repository: c.repository ?? "", container: c.container, source: c.source, copyright: c.copyright, note: c.note,
      text: c.text, info: {},
    });
  }
  return rows;
}

const isSpec = (t) => /^(npm|go|url):/.test(t);

/**
 * Fill each row's text from where it lives: node_modules (the same name@version only, when it has a
 * license file), the record of `--fetch`, or a file under third-party-licenses/. An npm text also
 * fills a missing license and repository from its package.json. Returns the specs whose text is not
 * there.
 */
function resolveTexts(rows, installed, fetched) {
  const missing = [];
  for (const row of rows) {
    if (!row.text) {
      missing.push(row);
    } else if (!isSpec(row.text)) {
      row.body = readText(join(OUT_DIR, row.text));
    } else {
      const local = row.text.startsWith("npm:") ? installed.get(row.text.slice(4)) : null;
      const localBody = local ? licenseFiles(local) : "";
      if (localBody) {
        const pkg = readJson(join(local, "package.json"));
        row.license ||= packageLicense(pkg) || LICENSE_NAMES[row.name] || "";
        row.repository ||= packageRepository(pkg);
        row.body = localBody;
      } else if (fetched[row.text] && existsSync(join(OUT_DIR, fetched[row.text].text))) {
        row.license ||= fetched[row.text].license || LICENSE_NAMES[row.name] || "";
        row.repository ||= fetched[row.text].repository ?? "";
        row.body = readText(join(OUT_DIR, fetched[row.text].text));
      } else {
        missing.push(row);
      }
    }
  }
  return missing;
}

/** Download the missing texts and record them in fetched.json */
async function fetchMissing(rows, fetched) {
  const done = new Set();
  for (const row of rows) {
    if (!isSpec(row.text ?? "") || done.has(row.text)) continue;
    done.add(row.text);
    console.log(`[licenses] fetch ${row.text}`);
    fetched[row.text] = await fetchText(row.text, row.info);
  }
  const sorted = Object.fromEntries(Object.keys(fetched).sort().map((k) => [k, fetched[k]]));
  writeFileSync(FETCHED, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/**
 * The keys of the hand ledger: the files its entries were read from. A different file does not
 * stop the generation; a warning says which entries to review.
 */
function checkLedgerKeys(ledger) {
  const warn = (key, what, now) => console.error(`[licenses] warning: ${what} differs from the hand ledger; review the entries with key "${key}" in embedded.json (now ${now})`);
  const { mermaid, d2, plantuml } = ledger.keys;
  const mermaidHash = sha256(mermaid.file);
  if (mermaidHash !== mermaid.sha256) warn("mermaid", `the sha256 of ${mermaid.file}`, mermaidHash);
  const d2Version = readJson(join(ROOT, "node_modules", d2.package, "package.json")).version;
  if (d2Version !== d2.version) warn("d2", `the version of ${d2.package}`, d2Version);
  const plantumlHash = sha256(plantuml.file);
  if (plantumlHash !== plantuml.sha256) warn("plantuml", `the sha256 of ${plantuml.file}`, plantumlHash);
}

/**
 * The files of the copied packages: each file listed in COPIED is in the build, and dist/d2/ holds
 * no file besides the listed ones and the extension's own. A difference does not stop the
 * generation; a warning says what to review.
 */
function checkCopiedFiles() {
  const warn = (what) => console.error(`[licenses] warning: ${what}; review COPIED in config.mjs and the entries with key "d2" in embedded.json`);
  const listed = COPIED.flatMap((c) => c.files);
  for (const file of listed) if (!existsSync(join(ROOT, file))) warn(`${file} is not in the build`);
  for (const name of readdirSync(join(ROOT, D2_DIR))) {
    const file = `${D2_DIR}/${name}`;
    if (!listed.includes(file) && !D2_OWN.includes(file)) warn(`${file} is not listed in COPIED`);
  }
}

/**
 * The records of `--fetch` that no component uses any more (their texts stay in texts/ and ship in
 * the VSIX). A warning names each one to remove with its file.
 */
function checkUnusedFetched(rows, fetched) {
  const used = new Set(rows.map((row) => row.text));
  for (const key of Object.keys(fetched)) {
    if (!used.has(key)) console.error(`[licenses] warning: no component uses "${key}" in fetched.json; remove it and ${fetched[key].text}`);
  }
}

/** One text section: a heading between two rules, then the notes and the license text */
function section(row, extra) {
  const lines = ["=".repeat(78), `${row.id} — ${row.license}`];
  if (row.repository) lines.push(row.repository);
  lines.push(...extra, "=".repeat(78), "");
  const notes = [...(row.copyright ?? []), ...(row.copyright?.length && row.note?.length ? [""] : []), ...(row.note ?? [])];
  /* A row whose ledger entry has copyright lines or a note gets only those (no note meant for npm packages on top) */
  const known = notes.length ? null : LICENSE_NOTES[row.name];
  if (known) notes.push(...known);
  if (notes.length) lines.push(...notes, "");
  lines.push(row.body, "");
  return lines;
}

function writeNpm(rows) {
  const csv = ['"module name","license","chosen","repository"'];
  const texts = [
    "Third-party npm packages bundled with PlantUML Markdown Preview",
    "",
    "Generated by scripts/licenses/generate.mjs. One section per npm package in the esbuild bundle",
    "(dist/extension.js; dist/scroll-sync-webview.js has none today) and per package that esbuild.js",
    "copies into dist/ (mermaid, katex, @terrastruct/d2): the package, its license and repository,",
    "followed by the license text shipped with it. The components inside those packages are in",
    "EMBEDDED-LICENSES.txt.",
    "",
  ];
  for (const row of rows) {
    csv.push([cell(row.id), cell(row.license), cell(row.chosen), cell(row.repository)].join(","));
    const extra = [];
    if (row.chosen !== row.license) extra.push(`Used under: ${row.chosen}`);
    if (row.publisher) extra.push(`Publisher: ${row.publisher}`);
    texts.push(...section(row, extra));
  }
  writeFileSync(join(OUT_DIR, "NPM-DEPENDENCIES.csv"), `${csv.join("\n")}\n`, "utf8");
  writeFileSync(join(OUT_DIR, "NPM-LICENSES.txt"), `${texts.join("\n")}\n`, "utf8");
}

function writeEmbedded(rows) {
  const csv = ['"module name","license","chosen","repository","container","source"'];
  const texts = [
    "Third-party components inside the files bundled with PlantUML Markdown Preview",
    "",
    "Generated by scripts/licenses/generate.mjs. One section per component that ships inside",
    "dist/mermaid.min.js or dist/d2/, and for the Graphviz build inside vendor/plantuml.jar: the",
    "component, its license, the file it is in, followed by its license text. The packages inside",
    "mermaid.min.js are listed at the versions mermaid was built with, which can differ from the ones",
    "installed in node_modules.",
    "",
  ];
  for (const row of rows) {
    csv.push([row.id, row.license, row.chosen, row.repository, row.container, row.source].map(cell).join(","));
    const extra = [`Inside: ${row.container}`];
    if (row.chosen !== row.license) extra.push(`Used under: ${row.chosen}`);
    if (row.source) extra.push(`Source: ${row.source}`);
    if (row.patched) extra.push("Patched by mermaid (not the npm release as it is)");
    texts.push(...section(row, extra));
  }
  writeFileSync(join(OUT_DIR, "EMBEDDED-COMPONENTS.csv"), `${csv.join("\n")}\n`, "utf8");
  writeFileSync(join(OUT_DIR, "EMBEDDED-LICENSES.txt"), `${texts.join("\n")}\n`, "utf8");
}

async function main() {
  const ledger = readJson(LEDGER);
  const fetched = existsSync(FETCHED) ? readJson(FETCHED) : {};
  const npm = npmRows();
  const embedded = embeddedRows(ledger, goBuildInfo());
  const installed = installedPackages();

  let missing = resolveTexts(embedded, installed, fetched);
  if (missing.length && process.argv.includes("--fetch")) {
    await fetchMissing(missing, fetched);
    missing = resolveTexts(missing, installed, fetched);
  }

  const problems = [];
  for (const row of missing) problems.push(`${row.id}: no license text (${row.text}; run with --fetch)`);
  for (const row of npm) row.body = row.text;
  for (const row of embedded) row.chosen = chosenLicense(row.license ?? "", row.chosen ?? CHOSEN[row.name]);
  for (const row of [...npm, ...embedded]) {
    if (missing.includes(row)) continue;
    if (!row.body) problems.push(`${row.id}: no license text`);
    const goModule = embedded.includes(row) && row.text.startsWith("go:");
    if (!row.license) problems.push(`${row.id}: no license name${goModule ? ' (add it to "go" in embedded.json)' : ""}`);
    else if (!row.chosen) problems.push(`${row.id}: ${row.license} has no chosen license`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`[licenses] ${p}`);
    process.exit(1);
  }

  checkLedgerKeys(ledger);
  checkCopiedFiles();
  checkUnusedFetched(embedded, fetched);
  embedded.sort((a, b) => byCode(a.container, b.container) || byCode(a.id, b.id));
  writeNpm(npm);
  writeEmbedded(embedded);
  console.log(`[licenses] ${npm.length} npm packages, ${embedded.length} embedded components`);
}

main().catch((err) => {
  if (!(err instanceof CollectError)) throw err;
  console.error(`[licenses] ${err.message}`);
  process.exit(1);
});
