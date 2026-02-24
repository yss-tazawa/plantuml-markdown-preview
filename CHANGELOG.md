# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
