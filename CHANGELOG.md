# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.5 - 2026-02-27

### Fixed

- PlantUML diagrams shrinking horizontally when the preview or browser window is narrowed; diagrams now retain their original size with horizontal scrolling when needed

## 0.1.4 - 2026-02-26

### Fixed

- HTML export "Open in Browser" failing on Windows when file path contains non-ASCII characters (e.g. Japanese)

## 0.1.3 - 2026-02-26

### Fixed

- Excessive vertical spacing inside blockquotes caused by paragraph margin stacking with blockquote padding

## 0.1.2 - 2026-02-26

### Added

- 8 new preview themes: Atom Light, One Light, Vue, Pen Paper Coffee, Coy, VS (light) and Atom Dark, Monokai (dark) — total 14 themes (8 light + 6 dark)
- Light/Dark separator labels in the theme picker QuickPick menu for easier navigation

### Changed

- Async file I/O for export and preview rendering (readFileSync → fs.promises)
- SHA-256 cache keys for PlantUML SVG cache (replaces MD5)
- PlantUML spawn timeout reduced from 30s to 15s
- Default `debouncePlantUmlMs` changed from 100 to 300
- Recognize all PlantUML `@start` tags (mindmap, wbs, etc.) not just `@startuml`

### Fixed

- Minor corrections in settings description text
- Disposable event handler leak (now registered via context.subscriptions)
- Floating promises on fire-and-forget VS Code commands
- CSP missing `font-src` directive
- Unescaped `lang` attribute in exported HTML

## 0.1.1 - 2026-02-25

### Changed

- Suppress "Rendering..." overlay and notification during text editing and file save; loading feedback is now shown only on tab switch and initial open

## 0.1.0 - 2026-02-25

Initial release.

### Added

- **Inline PlantUML preview** — render PlantUML code blocks as SVG directly in the Markdown preview, with real-time updates, auto-refresh on save, auto-follow on tab switch, loading indicator, and inline error display with line numbers
- **HTML export** — export Markdown to a self-contained HTML file with inline SVG diagrams and syntax highlighting CSS; option to export and open in browser in one step
- **Bidirectional scroll sync** — anchor-based scroll mapping between editor and preview with smooth position restoration after re-render
- **Themes** — 6 preview themes (GitHub Light/Dark, One Dark, Dracula, Solarized Light/Dark) with instant CSS-only switching; PlantUML theme support with dynamic theme discovery from the installed jar
- **Syntax highlighting** — 190+ languages via highlight.js, styled to match the selected preview theme
- **Security** — Content Security Policy with nonce-based script restrictions; no code execution from Markdown content
- **Keyboard shortcut** — `Cmd+Alt+V` (Mac) / `Ctrl+Alt+V` (Windows/Linux) to open preview
- **Context menus** — explorer, editor, and webview context menu integration
- **Internationalization** — English and Japanese
