<!-- markdownlint-disable -->
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.7.1 - 2026-04-09

### Fixed

- Fix preview jumping back to a stale source position after scrolling the preview while the source editor was hidden
- Fix source editor not following the preview when its tab is re-opened after being hidden
- Fix sub-line scroll drift when switching focus between the preview and the source editor

## 0.7.0 - 2026-03-26

### Added

- HTML export width submenu: choose Responsive, pixel-width presets (640–1440px), or left-aligned variants from the context menu
- PDF export orientation submenu: choose Portrait or Landscape
- `pdfScale` setting to control PDF export scale — text and diagrams scale uniformly (default 0.625)

### Changed

- Renamed "Fit to Width" to "Responsive" across all languages
- Shortened "Export as HTML & Open in Browser" to "Export as HTML & Open"
- HTML/PDF responsive export now preserves user-configured diagram scale (shrinks only if overflowing)
- D2 default scale changed from 75% to 70%

### Fixed

- Fix Mermaid diagrams not rendered in PDF export
- Fix PlantUML/D2 diagrams distorted (height not scaling with width) in responsive HTML export
- Fix D2 diagrams not shrinking in responsive HTML export

## 0.6.18 - 2026-03-25

### Added

- Bulk diagram export: export all diagrams from a Markdown file as individual PNG or SVG files

### Fixed

- Fix exported SVG files containing invalid XML entities (`&nbsp;`) and comments with double hyphens
- Fix single diagram PNG export failing silently for diagrams with `&nbsp;` in SVG output

## 0.6.17 - 2026-03-23

### Changed

- Improved scroll sync smoothness and accuracy

## 0.6.16 - 2026-03-23

### Fixed

- Fix preview jumping to wrong position when editing or selecting text in the editor

## 0.6.15 - 2026-03-22

### Fixed

- Fix preview scroll jumping on startup when the editor is not at the top

## 0.6.14 - 2026-03-21

### Changed

- Faster diagram patch updates in Secure mode
- Faster diagram patch updates in Easy mode

## 0.6.13 - 2026-03-21

### Fixed

- Secure mode patch rendering no longer sends diagram content to an external server — it now correctly uses the local Java process

## 0.6.12 - 2026-03-20

### Changed

- Significantly faster preview updates when editing diagrams in large files with many diagram blocks (PlantUML, Mermaid, D2)

### Fixed

- Preview no longer scrolls unexpectedly when a diagram changes size during editing
- D2 diagrams no longer disappear with an error while typing incomplete syntax
- `stateDiagram` (v1) keyword completion now works in Mermaid blocks
- HTML export no longer writes an empty file when rendering is cancelled

## 0.6.11 - 2026-03-19

### Fixed

- Scroll sync no longer moves the active view on tab switch; only the non-active side follows
- Reduced visible scroll animation when switching between editor and preview tabs
- Local server restart or port retry could fail silently after a previous stop
- "Go to top" nav button in preview did not sync the editor scroll position on tab switch

## 0.6.10 - 2026-03-18

### Changed

- Improved multilingual README translations

## 0.6.9 - 2026-03-18

### Added

- "Open Include Source" context menu for PlantUML diagrams in the preview — right-click a diagram that uses `!include` to open the included file directly. Supports quick pick when multiple includes are present.

## 0.6.8 - 2026-03-17

### Added

- GitHub Pages documentation site with multi-language support at `yss-tazawa.github.io/plantuml-markdown-preview`
- Language switcher links updated to GitHub Pages URLs for a seamless reading experience

## 0.6.7 - 2026-03-17

### Added

- README translations in 6 languages: Japanese, Simplified Chinese, Traditional Chinese, Korean, Spanish, and Brazilian Portuguese
- UI localization for Traditional Chinese (`zh-TW`), Korean (`ko`), Spanish (`es`), and Brazilian Portuguese (`pt-BR`)
- Language switcher navigation at the top of README.md linking to all 7 language versions

## 0.6.6 - 2026-03-15

### Changed

- Snippet prefixes for diagram templates now use `tmpl-` prefix (e.g., `tmpl-seq`, `tmpl-cls`) to clearly distinguish templates from keyword completions
- Unified snippet prefixes across PlantUML, Mermaid, and D2 for the same diagram types (e.g., class diagram is now `tmpl-cls` in all three)
- Renamed Markdown snippet prefixes for consistency: `mermaid-flowchart` → `mermaid-flow`, `d2-container` → `d2-comp`

## 0.6.5 - 2026-03-15

### Added

- Color swatches and color picker for PlantUML, Mermaid, and D2 color values (`#FF0000`, `#F00`, `#Red`) in standalone files and Markdown fenced blocks
- Keyword completion for PlantUML, Mermaid, and D2 — context-aware suggestions for keywords, skinparam properties, color names, shape types, style properties, and more
- "Go to Include File" context menu: right-click on a `!include` line in `.puml` or Markdown files to open the referenced file
- Auto-refresh preview when an included file is saved

## 0.6.4 - 2026-03-15

### Added

- Status bar indicator showing the current rendering mode and local server state
- "Select Rendering Mode" command to switch between Fast, Secure, and Easy modes from the status bar or Command Palette

## 0.6.3 - 2026-03-14

### Added

- Find widget (Cmd+F / Ctrl+F) support in Diagram Viewer and standalone file previews

## 0.6.2 - 2026-03-13

### Fixed

- Preview panel could not be reopened after switching editor tabs while the preview was open

## 0.6.1 - 2026-03-13

### Fixed

- Preview no longer briefly flashes at the top of the document before jumping to the correct scroll position when opened

## 0.6.0 - 2026-03-13

### Added

- D2 diagram support — render `d2` fenced code blocks in Markdown preview, HTML export, and standalone `.d2` file preview
- D2 theme selection (19 themes) and layout engine setting (`dagre` / `elk`)
- D2 diagram scale setting — `auto` (fit container) or fixed percentage (50%–100%, default 75%)
- Syntax highlighting for `d2` fenced code blocks in Markdown
- D2 snippet templates — type `d2-sequence`, `d2-class`, `d2-er`, `d2-flow`, etc. in Markdown files to insert diagram scaffolds
- D2 snippets inside fenced blocks — type `conn`, `seq`, `class`, `sql`, etc. for diagram templates

### Fixed

- Diagram Viewer now preserves zoom level and pan position when switching tabs or when the diagram content updates

## 0.5.9 - 2026-03-11

### Changed

- Diagram Viewer now opens from the right-click context menu instead of left-clicking the diagram

## 0.5.8 - 2026-03-10

### Added

- Copy Diagram as PNG command — right-click a diagram and copy it to the clipboard instantly

### Changed

- Diagram right-click menu now shows: Copy PNG, Save PNG, Save SVG (copy first for quick access)
- Diagram context menu items appear immediately when the preview opens, without waiting for scripts to load
- Webview text right-click menu now shows Cut/Copy/Paste before export items

## 0.5.7 - 2026-03-10

### Fixed

- Fixed `!include`/`!includesub` diagrams showing wrong content when clicked in markdown preview
- Diagram viewer now updates correctly when the preview panel is hidden behind it

### Removed

- Click-to-open standalone preview feature for included file references

## 0.5.6 - 2026-03-10

### Added

- PlantUML code snippets for Markdown files — type `plantuml-sequence`, `plantuml-class`, etc. to insert full fenced code blocks
- PlantUML snippets inside fenced blocks — type `seq`, `cls`, `act`, etc. for diagram templates
- Syntax highlighting for `plantuml` fenced code blocks in Markdown
- Mermaid code snippets for Markdown files — type `mermaid-sequence`, `mermaid-flowchart`, etc. to insert full fenced code blocks
- Mermaid snippets inside fenced blocks — type `seq`, `cls`, `flow`, etc. for diagram templates
- Syntax highlighting for `mermaid` fenced code blocks in Markdown

### Changed

- Easy mode description now says "PlantUML server" instead of "external server" for clarity

## 0.5.5 - 2026-03-09

### Fixed

- Local PlantUML server not starting automatically on VS Code launch in Fast mode

## 0.5.4 - 2026-03-09

### Added

- PlantUML `!include` support — included files are resolved and rendered inline; use the toolbar reload button to refresh after editing included files
- `plantumlIncludePath` setting to specify a custom base directory for `!include` resolution
- Click an included `.puml` file reference in the diagram to open its standalone preview

### Changed

- Bundled PlantUML jar updated to 1.2026.2

### Fixed

- Diagram Viewer zoom resets to fit-to-window when the diagram updates

## 0.5.3 - 2026-03-08

### Fixed

- Non-existent `plantumlJarPath` no longer causes render errors — automatically falls back to the bundled jar with a warning
- Secure mode now checks Java availability at startup, matching Fast mode behavior

### Changed

- Notification shown when `javaPath` or `plantumlJarPath` is changed to confirm the new setting is applied

## 0.5.2 - 2026-03-08

### Fixed

- Crash when `javaPath` setting is changed to a non-existent path while the extension is running

## 0.5.1 - 2026-03-08

### Fixed

- Mermaid preview: stale error SVG (bomb icon) no longer persists in the background after fixing a syntax error

## 0.5.0 - 2026-03-08

### Added

- Standalone preview for `.puml` and `.mmd` files with pan & zoom, live updates, and theme support — no Markdown wrapper needed
- Same keyboard shortcut (`Cmd+Alt+V` / `Ctrl+Alt+V`) auto-selects based on file type
- Save as PNG / SVG from standalone diagram previews via right-click

## 0.4.10 - 2026-03-07

### Fixed

- Diagram Viewer: horizontal mouse wheel now pans the diagram instead of being ignored

## 0.4.9 - 2026-03-07

### Added

- Save any diagram as PNG or SVG via right-click in the preview or Diagram Viewer

### Changed

- Minimum VS Code version bumped from 1.82.0 to 1.83.0

## 0.4.8 - 2026-03-07

### Changed

- Diagram Viewer: translated the "1:1" button label for all languages
- Diagram Viewer: add subtle button borders for better visibility in dark themes

### Fixed

- Clicking whitespace next to a diagram no longer opens the Diagram Viewer — only clicks on the diagram itself trigger it

## 0.4.7 - 2026-03-07

### Added

- Diagram Viewer: click any PlantUML or Mermaid diagram to open a separate pan & zoom panel with live sync, theme-matched background, and localized toolbar
- `enableDiagramViewer` setting to disable the click-to-open behavior (default: `true`)
- `retainPreviewContext` setting to control whether the preview retains its content when the tab is hidden (default: `true`). Prevents unnecessary re-rendering on tab switch at the cost of slightly higher memory usage.

### Fixed

- Fix theme flash when switching between files after changing the preview theme

## 0.4.6 - 2026-03-06

### Fixed

- Preview now shows an error message when rendering fails instead of displaying stale content
- Re-focusing the editor after a render failure now retries the render automatically
- Fix a race condition that could show the wrong file's content during rapid file switches
- Preview now re-renders correctly when the panel becomes visible after being hidden

## 0.4.5 - 2026-03-06

### Added

- Navigation toolbar with go-to-top / go-to-bottom buttons
- Table of Contents (TOC) sidebar for quick heading navigation
- PDF export via headless Chromium (Chrome, Edge, or Chromium required)
- Fit-to-width HTML export option for responsive diagram scaling

## 0.4.4 - 2026-03-05

### Changed

- File switching in the preview is now faster with no flickering

### Fixed

- Scroll position is now correctly preserved when switching between files
- Preview no longer briefly shows the wrong file's content during file switches

## 0.4.3 - 2026-03-04

### Added

- Java 11+ version check at startup with actionable error message for older versions

## 0.4.2 - 2026-03-04

### Fixed

- Fix local server startup notification message

## 0.4.1 - 2026-03-04

### Fixed

- Improve scroll sync accuracy for PlantUML documents

## 0.4.0 - 2026-03-03

### Added

- **Preset modes** — single `mode` setting (`fast` / `secure` / `easy`) replaces `renderMode` and controls rendering method, debounce timing, and security defaults together
  - **Fast** (default) — local PlantUML server on localhost, instant re-renders, debounce 100ms
  - **Secure** — local rendering only, no network access, local images blocked by default, debounce 300ms
  - **Easy** — no setup required, diagram source sent to PlantUML server, debounce 300ms
- `plantumlLocalServerPort` setting — specify a fixed port for the local server (default: auto-assign)
- Debounce and `allowLocalImages` settings can still be overridden individually
- Chinese (Simplified) localization (zh-cn)

### Changed

- **Breaking:** `renderMode` setting replaced by `mode`. Existing `renderMode` values are ignored — set the new `mode` setting instead.
- **Breaking:** Settings renamed — `jarPath` → `plantumlJarPath`, `serverUrl` → `plantumlServerUrl`, `localServerPort` → `plantumlLocalServerPort`. Existing values under the old names are ignored.
- **Breaking:** `allowLocalImages` changed from boolean (`true`/`false`) to a three-option dropdown (`mode-default`/`on`/`off`). `mode-default` uses the mode preset (Fast: on, Secure: off, Easy: on). Existing `true`/`false` values are ignored — reset to `mode-default` or set `on`/`off` explicitly.
- `debounceNoDiagramChangeMs` / `debounceDiagramChangeMs` now show as empty when unset (previously showed `0`); they inherit from the selected mode preset unless explicitly overridden

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

- Mermaid diagrams not rendering in the preview

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
