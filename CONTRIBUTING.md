# Contributing

Thank you for your interest in contributing to PlantUML Markdown Preview!
Whether it's a bug report, feature idea, code change, or translation improvement — all contributions are welcome.

## Ways to Contribute

- **Report a bug** — Found something broken? [Open a bug report](https://github.com/yss-tazawa/plantuml-markdown-preview/issues/new?template=bug_report.yml)
- **Suggest a feature** — Have an idea? [Open a feature request](https://github.com/yss-tazawa/plantuml-markdown-preview/issues/new?template=feature_request.yml)
- **Submit code** — Bug fixes, new features, refactoring (see [Development Setup](#development-setup) below)
- **Improve documentation** — Typo fixes, clarifications, examples
- **Add or improve translations** — See [Internationalization](#internationalization) below

> For non-trivial changes, please open an issue first to discuss the approach before investing time in a pull request.

## Reporting Issues

Before filing a new issue, please search [existing issues](https://github.com/yss-tazawa/plantuml-markdown-preview/issues) to avoid duplicates. When creating a new issue, use one of the provided templates — they include all the information needed for a quick diagnosis.

## Development Setup

### Prerequisites

| Tool | Purpose | Required | Verify |
| ---- | ------- | -------- | ------ |
| [Node.js](https://nodejs.org/) (LTS) | Build toolchain | Yes | `node -v` |
| Java (JRE or JDK) | Runs PlantUML (local mode) | Yes (local mode) | `java -version` |
| [Graphviz](https://graphviz.org/) | Renders class / component diagrams | Optional | `dot -V` |
| [plantuml.jar](https://plantuml.com/download) | PlantUML engine | Optional — bundled jar (LGPL) is included | — |
| [VS Code](https://code.visualstudio.com/) | Extension host | Yes | — |

### Clone and Install

```bash
git clone https://github.com/yss-tazawa/plantuml-markdown-preview.git
cd plantuml-markdown-preview
npm install
```

The bundled PlantUML jar (LGPL) is used by default. To use a different jar, set `plantumlMarkdownPreview.jarPath` in your VS Code settings. See [README.md](README.md#quick-start) for details.

### Build

| Command | Description |
| ------- | ----------- |
| `npm run build` | Bundle source + dependencies into `dist/extension.js` via esbuild |
| `npm run typecheck` | Type-check with `tsc --noEmit` (no output files) |
| `npm run package` | Type-check + build + generate `.vsix` package |

> **Note:** `tsc` is used only for type-checking. esbuild handles all bundling — runtime dependencies are inlined into a single `dist/extension.js`.

### Debug

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

## Project Structure

```text
extension.ts        Entry point — command registration, configuration, activation
src/
  preview.ts        Webview panel management and debouncing
  renderer.ts       markdown-it plugin — PlantUML fence blocks → SVG
  plantuml.ts       PlantUML local process invocation (sync + async), caching, theme discovery
  plantuml-server.ts PlantUML server rendering (HTTP fetch, encoding, LRU cache)
  exporter.ts       HTML export with inline SVG and syntax highlighting
  scroll-sync.ts    Bidirectional editor ↔ preview scroll sync
  utils.ts          Shared utilities (escapeHtml, getNonce, ensureStartEndTags, errorHtml, fence regex)
  themes/           CSS theme definitions (14 themes: 8 light + 6 dark)
l10n/               Localization bundles (English + Japanese)
.github/            GitHub templates (PR template, security policy)
dist/               Build output (gitignored)
```

## Coding Guidelines

- **Language:** TypeScript with strict mode
- **Comments:** Write JSDoc and inline comments in English
- **Style:** No linter or formatter is configured yet — follow the existing code style for consistency
- **Imports:** Use `.js` extensions in relative import paths (required by Node16 module resolution, e.g., `import { foo } from './src/bar.js'`)
- **Bundling:** All runtime dependencies are bundled by esbuild. The `vscode` module is external (provided by VS Code at runtime). Avoid adding dependencies that cannot be statically bundled.
- **Do not commit** `dist/`, `node_modules/`, or `.vsix` files (already in `.gitignore`)

## Internationalization

The extension supports English (default) and Japanese. There are two i18n mechanisms:

1. **Runtime strings** (messages shown to users at runtime):
   Use `vscode.l10n.t('...')` in TypeScript. Add the English string to `l10n/bundle.l10n.json`.

2. **Package manifest strings** (command titles, setting descriptions):
   Use `%key%` placeholders in `package.json`. Add the English string to `package.nls.json`.

Adding the English strings is sufficient — the maintainer will handle Japanese translations.

## Commit Messages and Branches

- Write commit messages in **English**
- [Conventional Commits](https://www.conventionalcommits.org/) are encouraged: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, etc.
- Branch prefixes: `feature/`, `fix/`, `docs/` (e.g., `feature/export-pdf`, `fix/scroll-sync-flicker`)

## Pull Request Process

1. Fork the repository and create a branch from **`develop`**
2. Make your changes
3. Ensure `npm run typecheck && npm run build` passes
4. Test manually via F5 debug (there are no automated tests yet — manual testing via the Extension Development Host is the primary verification method)
5. Push your branch and open a Pull Request against **`develop`**

> **Branch strategy:** `develop` is the working branch; `main` is the release branch. Always branch from and target `develop`.

The PR template will guide you through the required checklist. The maintainer may request changes or suggest revisions before merging.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
