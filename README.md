<p align="center">
  <img src="images/icon_512.png" width="128" alt="PlantUML Markdown Preview">
</p>

<h1 align="center">PlantUML Markdown Preview</h1>

<p align="center">
  <strong>Render PlantUML diagrams inline. Export to self-contained HTML. Secure by design.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/v/yss-tazawa.plantuml-markdown-preview" alt="VS Marketplace Version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/i/yss-tazawa.plantuml-markdown-preview" alt="Installs"></a>
  <a href="https://github.com/yss-tazawa/plantuml-markdown-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yss-tazawa/plantuml-markdown-preview" alt="License: MIT"></a>
</p>

<p align="center">
  <img src="images/hero-screenshot.png" width="800" alt="Editor and preview side by side in GitHub Light theme showing a sequence diagram">
</p>

## Highlights

- **Inline PlantUML rendering** — diagrams appear directly in your Markdown preview, not in a separate panel
- **Self-contained HTML export** — SVG diagrams embedded inline, zero external dependencies
- **Bidirectional scroll sync** — editor and preview scroll together, both ways
- **6 preview themes** — GitHub Light/Dark, One Dark, Dracula, Solarized Light/Dark
- **Secure** — CSP nonce-based policy, no code execution from Markdown content

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## Features

### Inline PlantUML Preview

Open any Markdown file and preview PlantUML code blocks rendered as SVG diagrams,
alongside your regular Markdown content.

- Real-time preview updates as you type (two-stage debouncing)
- Auto-refresh on file save
- Auto-follow when switching editor tabs
- Loading indicator during PlantUML rendering
- PlantUML syntax errors displayed inline with line numbers and source context

<!-- TODO: screenshot or GIF of live preview updating -->

### HTML Export

Export your Markdown document to a self-contained HTML file.

- PlantUML diagrams embedded as inline SVG
- Syntax highlighting CSS included — no external dependencies
- Export and open in browser in one command

### Bidirectional Scroll Sync

Editor and preview stay in sync as you scroll either one.

- Anchor-based scroll mapping with binary search and linear interpolation
- Smooth position restoration after re-render

### Themes

**Preview themes** control the overall document appearance:

| Theme | Style |
|-------|-------|
| GitHub Light | White background (default) |
| GitHub Dark | Dark background |
| One Dark | Atom-inspired dark |
| Dracula | Vibrant dark |
| Solarized Light | Warm beige, eye-friendly |
| Solarized Dark | Deep teal, eye-friendly |

Switch themes instantly from the title bar icon — no re-render needed (CSS-only swap).

**PlantUML themes** control diagram styling independently. The extension discovers
available themes from your PlantUML installation and presents them in a combined
QuickPick alongside preview themes.

<!-- TODO: screenshot of theme picker -->

### Syntax Highlighting

190+ languages supported via highlight.js. Code blocks are styled to match your
selected preview theme.

### Security

- Content Security Policy with nonce-based script restrictions
- No code execution from Markdown content
- User-authored `<script>` tags are blocked

## Quick Start

### Prerequisites

| Tool | Purpose | Verify |
|------|---------|--------|
| Java (JRE or JDK) | Runs PlantUML | `java -version` |
| [Graphviz](https://graphviz.org/) | Renders class / component diagrams | `dot -V` |
| [plantuml.jar](https://plantuml.com/download) | PlantUML rendering engine | — |

### Install

1. Open VS Code
2. Search for **PlantUML Markdown Preview** in the Extensions view (`Ctrl+Shift+X`)
3. Click **Install**

### Setup

Add to your VS Code settings (`Cmd+,` / `Ctrl+,`):

```json
{
  "plantumlMarkdownPreview.jarPath": "/path/to/plantuml.jar"
}
```

> **Note:** `javaPath` and `dotPath` default to `"java"` and `"dot"`.
> Only configure them if these commands are not on your PATH.

## Usage

### Open Preview

- **Keyboard shortcut:** `Cmd+Alt+V` (Mac) / `Ctrl+Alt+V` (Windows / Linux)
- **Context menu:** Right-click a `.md` file → **PlantUML Markdown Preview** → **Open Preview to Side**
- **Command Palette:** `PlantUML Markdown Preview: Open Preview to Side`

The preview uses its own theming independent of VS Code — default is a white background (GitHub Light).

### Export to HTML

Right-click a `.md` file → **PlantUML Markdown Preview** → **Export as HTML**

The HTML file is saved alongside the source `.md` file. To export and open in
your browser in one step, choose **Export as HTML & Open in Browser**.

### Change Theme

Click the theme icon in the preview panel title bar, or use the Command Palette:
**PlantUML Markdown Preview: Change Preview Theme**

### PlantUML Syntax

````markdown
```plantuml
Alice -> Bob: Hello
Bob --> Alice: Hi!
```
````

`@startuml` / `@enduml` wrappers are added automatically if omitted.

## Configuration

All settings use the `plantumlMarkdownPreview.` prefix.

### Required

| Setting | Default | Description |
|---------|---------|-------------|
| `jarPath` | `""` | Path to `plantuml.jar` |

### Optional

| Setting | Default | Description |
|---------|---------|-------------|
| `javaPath` | `"java"` | Path to Java executable |
| `dotPath` | `"dot"` | Path to Graphviz `dot` executable |
| `previewTheme` | `"github-light"` | Preview theme (see [Themes](#themes)) |
| `plantumlTheme` | `"default"` | PlantUML diagram theme (`-theme` CLI argument) |
| `debounceNoPlantUmlMs` | `100` | Debounce delay (ms) for non-PlantUML text changes |
| `debouncePlantUmlMs` | `100` | Debounce delay (ms) for PlantUML content changes |

<details>
<summary><strong>Preview theme options</strong></summary>

| Value | Description |
|-------|-------------|
| `github-light` | GitHub Light — white background (default) |
| `github-dark` | GitHub Dark — dark background |
| `one-dark` | One Dark — Atom-inspired dark |
| `dracula` | Dracula — vibrant dark palette |
| `solarized-light` | Solarized Light — warm beige, eye-friendly |
| `solarized-dark` | Solarized Dark — deep teal, eye-friendly |

</details>

## Keyboard Shortcuts

| Command | Mac | Windows / Linux |
|---------|-----|-----------------|
| Open Preview to Side | `Cmd+Alt+V` | `Ctrl+Alt+V` |

## FAQ

<details>
<summary><strong>PlantUML diagrams are not rendering</strong></summary>

1. Verify `jarPath` points to a valid `plantuml.jar` file
2. Run `java -version` in your terminal to confirm Java is installed
3. Run `dot -V` to confirm Graphviz is installed
4. Check the VS Code Output panel for error messages

</details>

<details>
<summary><strong>Diagrams look wrong with a dark theme</strong></summary>

Set a PlantUML theme to match your preview theme. Open the theme picker from the
title bar icon and select a dark PlantUML theme like `cyborg` or `mars`.

</details>

<details>
<summary><strong>Can I use <code>!theme</code> inside my PlantUML code?</strong></summary>

Yes. An inline `!theme` directive takes precedence over the extension setting.

</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build instructions,
and pull request guidelines.

## License

[MIT](LICENSE)
