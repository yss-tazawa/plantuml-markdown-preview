# Third-Party Licenses

This extension ships with the third-party components listed below: PlantUML (LGPL version), TextMate
grammars, an icon and color values from VS Code, icon paths from Octicons, and its npm dependencies
together with the separately licensed components inside them. The full license texts are in this
folder. The extension's own code is not covered by these licenses.

The bundled third-party components remain under their own licenses. This extension places no
additional restrictions on them: you may use, copy and redistribute each of them, including outside VS Code,
under the terms of its license.

The grammars are taken **unmodified** from the VS Code extensions published on Open VSX
(retrieved 2026-10-06) and live in `syntaxes/vendor/`. Each file's md5 is listed below.

As of 2026-10-06 the same files, at the same versions, ship in Plotdown.

## PlantUML

- Version: 1.2026.10 (LGPL version)
- License: GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later) — see `PlantUML-LICENSE.txt`,
  and the GNU General Public License v3.0 it incorporates — see `PlantUML-GPL-3.0.txt`
- Copyright: (C) Copyright 2009-2027, Arnaud Roques (as printed by `java -jar plantuml.jar -license`)
- Source: https://github.com/plantuml/plantuml/releases/tag/v1.2026.10 (the jar is
  `https://github.com/plantuml/plantuml/releases/download/v1.2026.10/plantuml-lgpl-1.2026.10.jar`)
- Corresponding source: the upstream project provides the source of this version both as the
  repository at the tag v1.2026.10, including its build scripts and standard library
  (https://github.com/plantuml/plantuml/archive/refs/tags/v1.2026.10.tar.gz), and as the Java sources
  of the LGPL build (https://github.com/plantuml/plantuml/releases/download/v1.2026.10/plantuml-lgpl-1.2026.10-sources.jar)
- Shipped as: `vendor/plantuml.jar`, unmodified (`vendor/NOTICE` repeats the version and the source)
- License text: https://www.gnu.org/licenses/lgpl-3.0.txt and https://www.gnu.org/licenses/gpl-3.0.txt,
  retrieved 2026-11-22, unmodified

### Graphviz inside the PlantUML jar

The PlantUML jar contains a build of Graphviz: Graphviz 2.44.1 for Windows is packed in
`net/sourceforge/plantuml/windowsdot/graphviz.dat`; its source
code is available at https://www2.graphviz.org/Packages/stable/portable_source/graphviz-2.44.1.tar.gz
(tag: https://gitlab.com/graphviz/graphviz/-/tree/2.44.1).

Graphviz is distributed under the Eclipse Public License 1.0 (see `Graphviz-LICENSE.txt`), not under
this extension's MIT license. It is provided on an "AS IS" basis, without warranties or conditions of
any kind, either express or implied, including warranties or conditions of title, non-infringement,
merchantability and fitness for a particular purpose; these are disclaimed on behalf of all
Contributors. No Contributor is liable for any damages, including direct, indirect, special,
incidental and consequential damages such as lost profits. Any provisions of this extension's license
that differ from the Eclipse Public License are offered by the author of this extension alone and not
by any other party.

- License: Eclipse Public License 1.0 (EPL-1.0) — see `Graphviz-LICENSE.txt`
- Copyright: Copyright (c) 2011 AT&T Intellectual Property (as stated at the top of the Graphviz
  source files; the Graphviz license file has no copyright line)
- Source: https://gitlab.com/graphviz/graphviz
- License text: the EPL-1.0 text, word for word the same as the `LICENSE` file of Graphviz 2.44.1
  (which `graphviz.dat` carries); only the line breaks differ

### Graphics inside the PlantUML jar that require attribution

- Emoji graphics (`net/sourceforge/plantuml/emoji/` in the PlantUML jar): Twemoji v14.0.2, Copyright
  2019 Twitter, Inc and other contributors, licensed under CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/). Source: https://github.com/twitter/twemoji/tree/v14.0.2.
  The PlantUML project adapted the graphics for PlantUML; this extension ships them as they are in
  the jar.
- AWS Architecture Icons (`awslib`, `awslib10`, `awslib14`, `awslib20` in the PlantUML standard
  library): from AWS Icons for PlantUML (https://github.com/awslabs/aws-icons-for-plantuml), Copyright
  Amazon.com, Inc. or its affiliates, licensed under CC BY-ND 2.0
  (https://creativecommons.org/licenses/by-nd/2.0/). Shipped as they are in the jar; the jar is not
  modified, so the license notices in its files (`SPDX-License-Identifier: CC-BY-ND-2.0`) are kept.
- Open Security Architecture icons (`osa`, `osa2` in the PlantUML standard library): by Open Security
  Architecture (https://www.opensecurityarchitecture.org/), licensed under CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/). The PlantUML standard library turned them into
  sprites; this extension ships them as they are in the jar.
- Font Awesome icons (`font-awesome`, `font-awesome-5` and `font-awesome-6` in `tupadr3` of the
  PlantUML standard library, from https://github.com/tupadr3/plantuml-icon-font-sprites 3.0.0):
  - Font Awesome 5 and 6 Free icons: by Fonticons, Inc. (https://fontawesome.com), licensed under
    CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
  - Font Awesome 4: Font Awesome by Dave Gandy (http://fontawesome.io); its font is licensed under
    the SIL Open Font License 1.1 (https://openfontlicense.org).
  - The PlantUML standard library turned them into sprites; this extension ships them as they are in
    the jar.

## PlantUML grammar (vscode-plantuml)

- Version: jebbs.plantuml 2.18.1 (https://github.com/qjebbs/vscode-plantuml)
- License: MIT — see `vscode-plantuml-LICENSE.txt` (Copyright (c) 2016 jebbs)
- Shipped as: `syntaxes/vendor/plantuml.tmLanguage` (md5 162533e2786dae7512cef42ff95c7f45)
  and `syntaxes/vendor/plantuml.language-configuration.json` (md5 b3a368910e6f3bb7d5faf508303d8041)
- Source: https://open-vsx.org/api/jebbs/plantuml/2.18.1/file/jebbs.plantuml-2.18.1.vsix

## Mermaid grammar (vscode-mermaid-syntax-highlight)

- Version: bpruitt-goddard.mermaid-markdown-syntax-highlighting 1.8.1
  (https://github.com/bpruitt-goddard/vscode-mermaid-syntax-highlight)
- License: MIT — see `vscode-mermaid-syntax-highlight-LICENSE.txt`
  (Copyright (c) 2018 Brian Pruitt-Goddard)
- Shipped as: `syntaxes/vendor/mermaid.tmLanguage.json` (md5 e5eb46307d7055629e9da282f06baf6c)
  and `syntaxes/vendor/mermaid.language-configuration.json` (md5 11c2e866ca2d20a0eb341d7ca99ebff9)
- Source: https://open-vsx.org/api/bpruitt-goddard/mermaid-markdown-syntax-highlighting/1.8.1/file/bpruitt-goddard.mermaid-markdown-syntax-highlighting-1.8.1.vsix

## D2 grammars (d2-vscode)

- Version: Terrastruct.d2 0.8.6 (https://github.com/terrastruct/d2-vscode)
- License: BSD-3-Clause — see `d2-vscode-LICENSE.txt` (Copyright 2022 Terrastruct, Inc.)
- Shipped as: `syntaxes/vendor/d2.tmLanguage.json` (md5 75f20334fcde4fd0acfbdc5fed321430),
  `syntaxes/vendor/markdown.tmLanguage.json` (md5 3ca23ac4b9e120370924382666128841)
  and `syntaxes/vendor/d2.language-configuration.json` (md5 e09c5c98c6faf6d71baca16a5fc70496)
- Source: https://open-vsx.org/api/Terrastruct/d2/0.8.6/file/Terrastruct.d2-0.8.6.vsix

### Markdown grammar inside the D2 extension (vscode-markdown-tm-grammar)

`markdown.tmLanguage.json` above is converted from microsoft/vscode-markdown-tm-grammar
(https://github.com/microsoft/vscode-markdown-tm-grammar, commit
a8545b220dc2cb109835571ba3458ff138e97361, as stated at the top of the file).
The D2 grammar includes it for the contents of `|md` block strings.

- License: MIT — see `vscode-markdown-tm-grammar-LICENSE.txt` (Copyright (c) Microsoft 2018)

## VS Code color values (microsoft/vscode)

The preview themes `vscode-light-2026` and `vscode-dark-2026` reproduce color values taken
from VS Code 1.146.0 (https://github.com/microsoft/vscode): the Light 2026 / Dark 2026
color themes and the built-in Markdown preview's stylesheets (including its highlight.js
styles). No VS Code files are shipped; only the color values are used, in
`src/themes/vscode-light-2026.ts` and `src/themes/vscode-dark-2026.ts`.

- License: MIT — see `vscode-LICENSE.txt` (Copyright (c) 2015 - present Microsoft Corporation)

## VS Code preview icon (microsoft/vscode)

The "Open Preview" command that stands in for VS Code's own while `useAsDefaultPreview` is on
uses the same icon as VS Code's. The two SVG files are copied **unmodified** from the built-in
Markdown extension of VS Code 1.146.0 (`extensions/markdown-language-features/media/`,
https://github.com/microsoft/vscode).

- License: MIT — see `vscode-LICENSE.txt` (Copyright (c) 2015 - present Microsoft Corporation)
- Shipped as: `images/vscode-preview-light.svg` (from `preview-light.svg`, md5 5944368b7ba7dc0281b621688e6d6f54)
  and `images/vscode-preview-dark.svg` (from `preview-dark.svg`, md5 f70fc340e69316a92cf2014a1a7485a4)

## GitHub alert icons (primer/octicons)

The five icons in the title line of GitHub alerts (`> [!NOTE]` and the like) are Octicons: `info`
(Note), `light-bulb` (Tip), `report` (Important), `alert` (Warning) and `stop` (Caution). The `<path>`
of each 16px SVG is copied **unmodified** from @primer/octicons 19.11.0 (https://github.com/primer/octicons)
into `src/markdown-rules.ts` and bundled into `dist/extension.js`. No Octicons package is installed.

- License: MIT — see `octicons-LICENSE.txt` (Copyright (c) 2024 GitHub Inc.)
- Source: https://github.com/primer/octicons/tree/v19.11.0/icons
- License text: https://raw.githubusercontent.com/primer/octicons/v19.11.0/LICENSE,
  retrieved 2026-11-22, unmodified

## Components inside npm packages under their own license

These ship inside an npm dependency but are licensed separately from it. The components inside the
npm packages are listed in `EMBEDDED-COMPONENTS.csv` and `EMBEDDED-LICENSES.txt` (see "npm
dependencies" below). The following are also described here: those that ship as separate files, those
whose license asks for more than its text (a source location, a chosen license or a credit), and the
larger components that d2 embeds in `d2.wasm`.

### KaTeX fonts

- Version: the fonts of katex 0.16.47 (`node_modules/katex/dist/fonts/`)
- License: SIL Open Font License 1.1 (OFL-1.1) — see `KaTeX-Fonts-OFL.txt`
- Copyright (as stated in each font's metadata):
  - Copyright (c) 2009-2010 Design Science, Inc.
  - Copyright (c) 2014-2018 Khan Academy
- Reserved Font Names: KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, KaTeX_Main, KaTeX_Math,
  KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1, KaTeX_Size2, KaTeX_Size3, KaTeX_Size4,
  KaTeX_Typewriter
- Source: https://github.com/KaTeX/KaTeX (fonts built by https://github.com/KaTeX/katex-fonts)
- Shipped as: the `KaTeX_*.woff2` files that `esbuild.js` copies into `dist/fonts/`. The fonts are
  not modified. HTML exports load the fonts from the jsDelivr CDN instead of embedding them.
- License text: the official OFL 1.1 text from https://openfontlicense.org/documents/OFL.txt,
  retrieved 2026-10-03, unmodified (its first lines are the template for the copyright statement;
  the statements that apply are the ones listed above).

### elkjs (inside @terrastruct/d2)

- Version: 0.8.2 (as stated in `d2layouts/d2elklayout/NOTICE.txt` of the d2 repository)
- License: Eclipse Public License 2.0 (EPL-2.0) — see `elkjs-LICENSE.txt`
- Copyright (as stated in the license banners of the file):
  - Copyright (c) 2017 Kiel University and others.
  - Copyright (c) 2021 Kiel University and others.
- Source: https://github.com/kieler/elkjs
- Shipped as: `dist/d2/elk.js`, which `@terrastruct/d2` (MPL-2.0, listed below) ships in its own
  package and `esbuild.js` copies unmodified.
- License text: https://raw.githubusercontent.com/kieler/elkjs/0.8.2/LICENSE.md, retrieved 2026-11-22,
  unmodified

elkjs is distributed under the Eclipse Public License 2.0, not under this extension's MIT license. Its
Source Code is available under the EPL-2.0 from the upstream project, at the tag 0.8.2:
https://github.com/kieler/elkjs/tree/0.8.2. `elk.js` is compiled with GWT from the Java sources of the
Eclipse Layout Kernel (ELK, also under the EPL-2.0). According to its release notes
(https://github.com/kieler/elkjs/releases/tag/0.8.2), elkjs 0.8.2 is based on ELK 0.8.1, whose sources
are at https://github.com/eclipse/elk/tree/v0.8.1.

### MathJax (inside @terrastruct/d2)

- Version: 3.2.2 (as stated in the file)
- License: Apache License 2.0 (Apache-2.0) — see `EMBEDDED-LICENSES.txt`
- Copyright: the file has no copyright line; its header reads "This is a custom build of MathJax"
  and names the Apache License 2.0
- Source: https://github.com/mathjax/MathJax-src/tree/3.2.2
- Shipped as: part of `dist/d2/d2.wasm` (a custom build of MathJax that d2 compresses into its Wasm
  binary, with the mhchemParser of Martin Hensel inside it, also Apache-2.0)

### dagre (inside @terrastruct/d2)

- Version: 0.8.5 (as stated in the file)
- License: MIT — see `EMBEDDED-LICENSES.txt`
- Copyright (as stated in its license file):
  - Copyright (c) 2012-2014 Chris Pettitt
- Source: https://github.com/dagrejs/dagre/tree/v0.8.5
- Shipped as: part of `dist/d2/d2.wasm` (d2 compresses dagre's prebuilt `dagre.js` into its Wasm
  binary). `dagre.js` bundles graphlib 2.1.8 (its bundled files carry a BSD-3-Clause notice; the
  upstream license is MIT) and lodash modules (MIT); both are listed in `EMBEDDED-LICENSES.txt`.

### github-markdown-css (inside @terrastruct/d2)

- Version: not stated (d2 ships a modified copy as `d2renderers/d2svg/github-markdown.css`)
- License: MIT — see `EMBEDDED-LICENSES.txt`
- Copyright (as stated in its license file):
  - Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
- Source: https://github.com/sindresorhus/github-markdown-css
- Shipped as: part of `dist/d2/d2.wasm`

### util-go (inside @terrastruct/d2)

- Version: v0.0.0-20250213174338-243d8661088a (as listed in the Go build info of `d2.wasm`)
- License: ISC — see `EMBEDDED-LICENSES.txt`
- Copyright (as stated in its license file):
  - Copyright (c) 2022 Terrastruct Inc.
- Source: https://oss.terrastruct.com/util-go
- Shipped as: part of `dist/d2/d2.wasm`

### Freetype-Go (inside @terrastruct/d2)

- Version: v0.0.0-20170609003504-e2365dfdc4a0 (as listed in the Go build info of `d2.wasm`)
- License: FreeType License (FTL), chosen from (FTL OR GPL-2.0-or-later) — see `EMBEDDED-LICENSES.txt`
- Copyright (as stated in its source files):
  - Copyright 2010 The Freetype-Go Authors
- Source: https://github.com/golang/freetype
- Shipped as: part of `dist/d2/d2.wasm`

Freetype-Go (golang/freetype) is offered under a choice of the FreeType License (FTL) or the GNU GPL
v2 or later (see its `LICENSE`). This extension uses it under the FTL, not the GPL; the FTL text is
its `licenses/ftl.txt`, included in `EMBEDDED-LICENSES.txt`. As the FTL asks:

Portions of this software are copyright © 1996-2002, 2006 The FreeType Project
(https://www.freetype.org). All rights reserved.

## npm dependencies

The extension ships npm packages in two ways: esbuild bundles some of them into
`dist/extension.js` (`dist/scroll-sync-webview.js` has none today), and `esbuild.js` copies files
of three of them unmodified (`dist/mermaid.min.js` from mermaid, `dist/katex.min.css` and
`dist/fonts/` from katex, `dist/d2/` from @terrastruct/d2).

- `NPM-DEPENDENCIES.csv` — the index: name@version, license, the license used (when there is a
  choice) and repository of each package in the bundles and of the three copied packages (the
  extension itself is excluded).
- `NPM-LICENSES.txt` — the texts: the same list with each package's own license file appended, so
  the MIT / BSD / ISC / Apache copyright notices ship with the extension as those licenses require.
- `EMBEDDED-COMPONENTS.csv` — the index of the components inside the shipped files, with the file
  each one is in: the packages baked into `dist/mermaid.min.js`, the Go modules, Go itself and the
  other components inside `dist/d2/`, and the Graphviz build inside `vendor/plantuml.jar`.
- `EMBEDDED-LICENSES.txt` — their texts, with the copyright lines taken from the shipped files when
  a license file has none.

All four are generated by `npm run licenses` (a build, then `node scripts/licenses/generate.mjs`)
and committed, so changes are visible in the diff. The generator reads what the build shipped (the
esbuild metafiles, the source maps of mermaid and of its parser, and the Go build info in
`d2.wasm`), and takes what cannot be read that way from the hand-maintained list
`scripts/licenses/embedded.json`.
License texts that are not in `node_modules` are kept in `texts/` (taken by
`npm run licenses -- --fetch` from the npm registry, the Go module proxy or the upstream repository).

`dist/mermaid.min.js` is mermaid's prebuilt bundle. The packages inside it are listed at the
versions mermaid was built with (for example DOMPurify 3.4.0), read from mermaid's source map; they
can differ from the versions installed in `node_modules`.

`@terrastruct/d2@0.1.33` carries no license file of its own (only a README, which is not a license
text). The generator takes its text from `npm-texts/terrastruct-d2.txt`, copied unmodified
from the upstream repository at the commit the package was published from (its npm `gitHead`),
retrieved 2026-10-03:
https://raw.githubusercontent.com/terrastruct/d2/581c91096b62d644fb5168313142c836b7e68e74/LICENSE.txt

@terrastruct/d2 is distributed under the Mozilla Public License 2.0, not under this extension's MIT
license. This extension ships files of the npm package
(https://registry.npmjs.org/@terrastruct/d2/-/d2-0.1.33.tgz) unmodified. Its source code is available
from the upstream repository (https://github.com/terrastruct/d2). According to the Go build info in
`d2.wasm`, upstream built the Wasm binary from commit 581c91096b62d644fb5168313142c836b7e68e74
(https://github.com/terrastruct/d2/tree/581c91096b62d644fb5168313142c836b7e68e74) with uncommitted
local changes (`vcs.modified=true`).

`dompurify` (inside `dist/mermaid.min.js`) is offered under (MPL-2.0 OR Apache-2.0); this extension
uses it under the Apache License 2.0. Its license file carries the copyright line ("Copyright 2025
Dr.-Ing. Mario Heiderich, Cure53"), the choice of the two licenses and both texts; the generator puts
the copyright notice from the package's own license banner (`dist/purify.js`: "(c) Cure53 and other
contributors") and the chosen license in front of it in `EMBEDDED-LICENSES.txt`. Neither the package
nor the upstream repository ships a NOTICE file.

## Keeping this up to date

When `vendor/plantuml.jar` is updated, update the version and the source URLs in "PlantUML", in
`vendor/NOTICE` and in the Third-Party Licenses section of the 14 README files (`README*.md`,
`docs/README.md`, `docs/*/README.md`), and review "Graphviz inside the PlantUML jar" and "Graphics
inside the PlantUML jar that require attribution".
When dependencies change, or mermaid, katex, @terrastruct/d2 or the jar is updated, run `npm ci` and
then `npm run licenses` (with `-- --fetch` when it reports a missing text), and read the diff of the
four generated files: a new, changed or removed component may need the hand-maintained list
(`scripts/licenses/embedded.json`) and this file updated. The generator warns when
`dist/mermaid.min.js`, @terrastruct/d2 or the jar is not the one the hand-maintained list was written
for.
When `@terrastruct/d2` is updated, take its license text again from the new `gitHead`, and update the
commit and the package URL in "npm dependencies".
When `katex`, `@terrastruct/d2` or `mermaid` is updated, update the versions in "Components inside
npm packages under their own license" (the KaTeX copyright lines are read from the fonts' metadata,
the elkjs version from the d2 repository, the ELK version from the elkjs release notes).
