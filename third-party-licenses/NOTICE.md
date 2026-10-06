# Third-Party Licenses

This extension ships the TextMate grammars listed below. Each keeps its own license;
the full texts are in this folder. The extension's own code is not covered by them.

The grammars are taken **unmodified** from the VS Code extensions published on Open VSX
(retrieved 2026-10-06) and live in `syntaxes/vendor/`. Each file's md5 is listed below.

As of 2026-10-06 the same files, at the same versions, ship in Plotdown.

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
