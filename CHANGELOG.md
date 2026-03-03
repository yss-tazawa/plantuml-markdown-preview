# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.4.0 - 2026-03-03

### Added

- **Local Server rendering mode** — run a PlantUML picoweb server locally for faster diagram rendering without sending data to an external server; set `renderMode` to `local-server`
- `localServerPort` setting — specify a fixed port for the local server (default: auto-assign)

### Fixed

- Fix inaccurate descriptions for `debounceNoDiagramChangeMs` / `debounceDiagramChangeMs` settings

## 0.3.6 - 2026-03-03

### Fixed

- Server render mode only showed "HTTP 400 Bad Request" for PlantUML syntax errors. Now the error diagram from the server is displayed, showing exactly where the syntax error occurred

## 0.3.5 - 2026-03-02

### Fixed

- HTML export "Open in Browser" failing on Windows when the file path contains non-ASCII characters (e.g. Japanese)
- "Rendering diagrams..." notification not appearing when switching between Markdown files
- Preview panel stealing focus when opening a file in the same editor column as the preview

## 0.3.4 - 2026-03-02

### Fixed

- Exported HTML had excessive top padding compared to the preview panel

## 0.3.3 - 2026-03-02

### Fixed

- Fix some PlantUML diagrams not rendering when a document contains duplicate diagram blocks
- Faster PlantUML rendering for documents with multiple diagrams

## 0.3.2 - 2026-03-02

### Fixed

- Java not detected on Windows when VS Code is launched from a shortcut
- Java path resolution now checks `JAVA_HOME` environment variable before falling back to `java` on PATH

## 0.3.1 - 2026-03-02

### Fixed

- Mermaid diagrams not rendering — webview's `localResourceRoots` was missing the extension's dist directory, blocking mermaid.min.js from loading

## 0.3.0 - 2026-03-02

### Added

- **Mermaid diagram support** — render `mermaid` code blocks in the preview and HTML export using client-side mermaid.js; no Java required
- `mermaidTheme` setting — choose from 5 themes (default / dark / forest / neutral / base) with QuickPick integration
- `plantumlScale` setting — control PlantUML diagram size (auto / 70%–120%)
- `mermaidScale` setting — control Mermaid diagram size (auto / 50%–100%)
- `htmlMaxWidth` setting — set the maximum width of exported HTML (640px–1440px / none)
- `htmlAlignment` setting — set the alignment of exported HTML body (center / left)

## 0.2.2 - 2026-03-01

### Fixed

- Excessive top margin in the preview panel — now matches VS Code's built-in Markdown preview

## 0.2.1 - 2026-03-01

### Changed

- Preview no longer freezes while rendering PlantUML diagrams in local mode
- Preview opens instantly with a progress notification

### Fixed

- XSS vulnerability in error messages displayed in the preview
- Scroll sync drifting after images finish loading

## 0.2.0 - 2026-02-28

### Added

- **Server rendering mode** — render diagrams via an external PlantUML server without requiring Java; set `renderMode` to `server` and optionally configure `serverUrl`
- `renderMode` setting — choose between `local` (default) and `server`
- `serverUrl` setting — PlantUML server URL (default: `https://www.plantuml.com/plantuml`)
- Notification when Java is not found, offering to switch to server mode

### Changed

- HTML export supports server rendering mode
- PlantUML themes now work in server mode

## 0.1.9 - 2026-02-28

### Added

- Bundled PlantUML jar — no separate download required; works out of the box with Java

## 0.1.8 - 2026-02-28

### Added

- `allowLocalImages` setting — resolve relative image paths in the preview (enabled by default)
- `allowHttpImages` setting — allow loading images over HTTP in the preview (disabled by default)

## 0.1.7 - 2026-02-27

### Changed

- Tables scroll horizontally for wide content
- Long unbroken text wraps at container boundaries
- Preview uses full viewport width

### Fixed

- Unwanted horizontal scrollbar on PlantUML diagrams in HTML export

## 0.1.6 - 2026-02-27

### Changed

- Preview uses full-width left-aligned layout
- PlantUML diagrams are left-aligned in both preview and HTML export

## 0.1.5 - 2026-02-27

### Fixed

- PlantUML diagrams shrinking when the preview or browser window is narrowed

## 0.1.4 - 2026-02-26

### Fixed

- HTML export "Open in Browser" failing on Windows with non-ASCII file paths

## 0.1.3 - 2026-02-26

### Fixed

- Excessive vertical spacing inside blockquotes

## 0.1.2 - 2026-02-26

### Added

- 8 new preview themes (14 total): Atom Light, One Light, Vue, Pen Paper Coffee, Coy, VS, Atom Dark, Monokai
- Light/Dark separator labels in the theme picker

### Changed

- Default `debouncePlantUmlMs` changed from 100 to 300
- Support all PlantUML diagram types (mind map, WBS, etc.)
- Improved settings descriptions

### Fixed

- Fonts not loading in the preview panel

## 0.1.1 - 2026-02-25

### Changed

- Loading overlay no longer appears during typing and file save

## 0.1.0 - 2026-02-25

Initial release.

### Added

- **Inline PlantUML preview** — render PlantUML code blocks as SVG in the Markdown preview with real-time updates and inline error display
- **HTML export** — export Markdown to a self-contained HTML file with inline SVG diagrams
- **Bidirectional scroll sync** — anchor-based scroll mapping between editor and preview
- **Themes** — 6 preview themes with instant switching; PlantUML theme support
- **Syntax highlighting** — 190+ languages via highlight.js
- **Keyboard shortcut** — `Cmd+Alt+V` / `Ctrl+Alt+V` to open preview
- **Context menus** — explorer, editor, and webview context menu integration
- **Internationalization** — English and Japanese
