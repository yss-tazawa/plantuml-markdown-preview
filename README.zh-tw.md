<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-cn.md">简体中文</a> | <strong>繁體中文</strong> | <a href="README.ko.md">한국어</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.pt-br.md">Português</a>
</p>

<p align="center">
  <img src="images/icon_512.png" width="128" alt="PlantUML Markdown Preview">
</p>

<h1 align="center">PlantUML Markdown Preview</h1>

<p align="center">
  <strong>3 種模式適配您的工作流程。內嵌渲染 PlantUML、Mermaid 和 D2 — 快速、安全或零設定。</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/v/yss-tazawa.plantuml-markdown-preview" alt="VS Marketplace Version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/i/yss-tazawa.plantuml-markdown-preview" alt="Installs"></a>
  <a href="https://github.com/yss-tazawa/plantuml-markdown-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yss-tazawa/plantuml-markdown-preview" alt="License: MIT"></a>
</p>

<p align="center">
  <img src="images/hero-screenshot.png" width="800" alt="編輯器與預覽並排，GitHub Light 主題下的循序圖">
</p>

## 選擇模式

| | **Fast**（預設） | **Secure** | **Easy** |
| --- | --- | --- | --- |
| | 即時重新渲染 | 最高隱私保護 | 零設定 |
| | 在 localhost 執行 PlantUML 伺服器 — 無 JVM 啟動開銷，即時更新 | 無網路、無背景程序 — 一切在本機完成 | 無需 Java — 使用 PlantUML 伺服器開箱即用 |
| **Java** | 需要 11+ | 需要 11+ | 不需要 |
| **網路** | 無 | 無 | 需要 |
| **隱私** | 僅本機 | 僅本機 | 圖表原始碼傳送至 PlantUML 伺服器 |
| **設定** | [安裝 Java →](#prerequisites) | [安裝 Java →](#prerequisites) | 無需設定 |

隨時透過單一設定切換模式 — 無需遷移，無需重啟。

> 詳情請參閱[渲染模式](#渲染模式)，完整設定說明請參閱[快速開始](#快速開始)。

## 亮點

- **內嵌渲染 PlantUML、Mermaid 和 D2** — 圖表直接顯示在 Markdown 預覽中，而非獨立面板
- **安全設計** — 基於 CSP nonce 的策略阻止所有來自 Markdown 內容的程式碼執行
- **圖表縮放控制** — 獨立調整 PlantUML、Mermaid 和 D2 圖表大小
- **自包含 HTML 匯出** — SVG 圖表內嵌，可設定版面寬度和對齊方式
- **PDF 匯出** — 透過無頭 Chromium 一鍵匯出，圖表自動縮放適配頁面
- **雙向捲動同步** — 編輯器與預覽雙向聯動捲動
- **導覽與目錄** — 跳至頂部/底部按鈕及預覽面板目錄側邊欄
- **圖表檢視器** — 右鍵任意圖表開啟平移和縮放面板，即時同步並匹配主題背景
- **獨立圖表預覽** — 直接預覽 `.puml`、`.mmd`、`.d2` 檔案，支援平移縮放、即時更新和主題 — 無需 Markdown 包裝
- **儲存/複製圖表為 PNG/SVG** — 在預覽或圖表檢視器中右鍵圖表儲存或複製到剪貼簿
- **14 種預覽主題** — 淺色 8 種 + 深色 6 種（GitHub、Atom、Solarized、Dracula、Monokai 等）
- **編輯器輔助** — PlantUML、Mermaid、D2 的關鍵字補全、顏色選擇器和程式碼片段
- **國際化** — 支援英語、簡體中文和日語介面
- **數學公式支援** — 使用 [KaTeX](https://katex.org/) 渲染 `$...$` 行內公式和 `$$...$$` 區塊公式

## 功能

### 內嵌圖表預覽

```` ```plantuml ````、```` ```mermaid ````、```` ```d2 ```` 程式碼區塊與一般 Markdown 內容一起渲染為內嵌 SVG 圖表。

- 輸入時即時更新預覽（兩階段防抖）
- 儲存檔案時自動更新
- 切換編輯器分頁時自動跟隨
- 圖表渲染時顯示載入指示器
- 內嵌顯示語法錯誤，附帶行號和原始碼上下文
- PlantUML：透過 Java（Secure/Fast 模式）或遠端 PlantUML 伺服器（Easy 模式）渲染
- Mermaid：使用 [mermaid.js](https://mermaid.js.org/) 在用戶端渲染 — 無需 Java 或外部工具
- D2：使用 [@terrastruct/d2](https://d2lang.com/)（Wasm）在用戶端渲染 — 無需外部工具

### 渲染模式

| | Fast（預設） | Secure | Easy |
| --- | --- | --- | --- |
| **需要 Java** | 是 | 是 | 否 |
| **網路** | 無（僅 localhost） | 無 | 需要 |
| **隱私** | 圖表保留在本機 | 圖表保留在本機 | 圖表原始碼傳送至 PlantUML 伺服器 |
| **速度** | 常駐 PlantUML 伺服器 — 即時重新渲染 | 每次渲染啟動 JVM | 依賴網路 |
| **並行數** | 50（並行 HTTP） | 1（批次） | 5（並行 HTTP） |

- **Fast 模式**（預設）— 在 `localhost` 啟動常駐 PlantUML 伺服器。消除每次編輯的 JVM 啟動開銷，以高並行實現即時重新渲染。圖表不會傳送到機器外部。
- **Secure 模式** — 在本機使用 Java + PlantUML jar。圖表不會傳送到機器外部。無網路存取。為最高安全性，預設封鎖本機圖片。
- **Easy 模式** — 將 PlantUML 原始碼傳送至伺服器渲染。無需設定。預設使用公共伺服器（`https://www.plantuml.com/plantuml`）。可設定自己的伺服器 URL 保護隱私。

未偵測到 Java 時，開啟預覽會提示切換到 Easy 模式。

### 圖表縮放

- **PlantUML 縮放** — `auto`（縮小以適應寬度）或固定百分比（70%–120%，預設 100%）
- **Mermaid 縮放** — `auto`（適應容器寬度）或固定百分比（50%–100%，預設 80%）
- **D2 縮放** — `auto`（適應容器寬度）或固定百分比（50%–100%，預設 75%）

### 圖表檢視器

右鍵預覽中的任意圖表，選擇**在圖表檢視器中開啟**，開啟平移和縮放專用面板。

- 滑鼠滾輪縮放（以游標為中心）、拖曳平移
- 工具列：適應視窗、1:1 重設、步進縮放（+/−）
- 即時同步 — 編輯器變更即時反映，縮放位置保持不變
- 背景色與目前預覽主題匹配
- 切換到其他來源檔案時自動關閉
- **儲存/複製為 PNG/SVG** — 右鍵圖表儲存或複製到剪貼簿
- 可透過 `enableDiagramViewer: false` 停用

### 雙向捲動同步

編輯器與預覽在任意一側捲動時保持同步。

### 主題

**預覽主題**控制文件整體外觀。

**淺色主題：** GitHub Light（預設）、Atom Light、One Light、Solarized Light、Vue、Pen Paper Coffee、Coy、VS

**深色主題：** GitHub Dark、Atom Dark、One Dark、Dracula、Solarized Dark、Monokai

透過標題列圖示即時切換預覽主題 — 無需重新渲染（僅 CSS 切換）。

### 安全性

- 基於 nonce 的指令碼限制內容安全原則（CSP）
- 阻止所有來自 Markdown 內容的程式碼執行
- HTTP 圖片載入預設關閉（`allowHttpImages`）

## 快速開始

### 前置條件

**Mermaid** — 無前置條件，開箱即用。

**D2** — 無前置條件，使用內建 [D2](https://d2lang.com/) Wasm，開箱即用。

**PlantUML（Easy 模式）** — 無前置條件。圖表原始碼傳送至 PlantUML 伺服器渲染。

**PlantUML（Fast/Secure 模式）** — 預設：

| 工具 | 用途 | 驗證 |
| --- | --- | --- |
| Java 11+（JRE 或 JDK） | 執行 PlantUML（內建 PlantUML 1.2026.2 需要 Java 11+） | `java -version` |
| [Graphviz](https://graphviz.org/) | 選用 — 類別圖、元件圖等版面相關圖表需要 | `dot -V` |

> **注意：** PlantUML jar（LGPL，v1.2026.2）已內建於擴充功能中，無需另行下載。**需要 Java 11 或更高版本。**
>
> **提示：** 如未安裝 Java，開啟預覽時擴充功能會提示切換到 Easy 模式。

### 安裝

1. 開啟 VS Code
2. 在擴充功能檢視（`Ctrl+Shift+X` / `Cmd+Shift+X`）中搜尋 **PlantUML Markdown Preview**
3. 點擊**安裝**

### 設置

**Fast 模式**（預設）：啟動常駐本機 PlantUML 伺服器，即時重新渲染。需要 Java 11+。

**使用 Secure 模式**：將 `mode` 設為 `"secure"`。無背景伺服器或網路存取，每次渲染使用 Java 11+。

**使用 Easy 模式**（無需設定）：將 `mode` 設為 `"easy"`。圖表原始碼傳送至 PlantUML 伺服器渲染。

#### Windows

1. 如未安裝 Java，請安裝（開啟 PowerShell 執行）：

   ```powershell
   winget install Microsoft.OpenJDK.21
   ```

2. 下載 [GPLv2 版 PlantUML](https://plantuml.com/download)（`plantuml-gplv2-*.jar`）到任意資料夾（內建 Graphviz）
3. 開啟 VS Code 設定（`Ctrl+,`），搜尋 `plantumlMarkdownPreview.plantumlJarPath`，輸入 `.jar` 完整路徑

#### Mac

1. 透過 Homebrew 安裝 Java 和 Graphviz：

   ```sh
   brew install openjdk graphviz
   ```

#### Linux

1. 安裝 Java 和 Graphviz：

   ```sh
   sudo apt install default-jdk graphviz
   ```

## 使用方式

### 開啟預覽

- **鍵盤快捷鍵：** `Cmd+Alt+V`（Mac）/ `Ctrl+Alt+V`（Windows/Linux）
- **右鍵選單：** 右鍵 `.md` 檔案 → **PlantUML Markdown Preview** → **在側邊開啟預覽**
- **命令面板：** `PlantUML Markdown Preview: Open Preview to Side`

### 匯出為 HTML / PDF

- 右鍵 `.md` 檔案 → **PlantUML Markdown Preview** → **匯出為 HTML** 或 **匯出為 PDF**
- PDF 匯出需要 Chrome、Edge 或 Chromium

### 儲存/複製圖表為 PNG/SVG

- 在預覽或圖表檢視器中右鍵圖表 → **複製圖表為 PNG**、**儲存圖表為 PNG** 或 **儲存圖表為 SVG**

### 更改主題

點擊預覽面板標題列的主題圖示，或使用命令面板：`PlantUML Markdown Preview: Change Preview Theme`

## 設定

所有設定使用 `plantumlMarkdownPreview.` 前置詞。

| 設定 | 預設值 | 說明 |
| --- | --- | --- |
| `mode` | `"fast"` | 預設模式。`"fast"` — 本機伺服器。`"secure"` — 無網路。`"easy"` — 無需設定。 |
| `javaPath` | `"java"` | Java 執行檔路徑 |
| `plantumlJarPath` | `""` | `plantuml.jar` 路徑。留空使用內建 jar |
| `dotPath` | `"dot"` | Graphviz `dot` 執行檔路徑 |
| `plantumlIncludePath` | `""` | PlantUML `!include` 指令的基礎目錄 |
| `allowLocalImages` | `"mode-default"` | 在預覽中解析相對圖片路徑 |
| `allowHttpImages` | `false` | 允許在預覽中透過 HTTP 載入圖片 |
| `previewTheme` | `"github-light"` | 預覽主題 |
| `plantumlTheme` | `"default"` | PlantUML 圖表主題 |
| `mermaidTheme` | `"default"` | Mermaid 圖表主題 |
| `plantumlScale` | `"100%"` | PlantUML 圖表縮放 |
| `mermaidScale` | `"80%"` | Mermaid 圖表縮放 |
| `d2Theme` | `"Neutral Default"` | D2 圖表主題 |
| `d2Layout` | `"dagre"` | D2 版面引擎 |
| `d2Scale` | `"75%"` | D2 圖表縮放 |
| `htmlMaxWidth` | `"960px"` | 匯出 HTML 的最大寬度 |
| `htmlAlignment` | `"center"` | HTML 對齊方式 |
| `enableMath` | `true` | 啟用 KaTeX 數學渲染 |
| `plantumlServerUrl` | `"https://www.plantuml.com/plantuml"` | Easy 模式的 PlantUML 伺服器 URL |
| `enableDiagramViewer` | `true` | 啟用圖表檢視器右鍵選單項目 |

## 鍵盤快捷鍵

| 命令 | Mac | Windows / Linux |
| --- | --- | --- |
| 在側邊開啟預覽（Markdown） | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| 預覽 PlantUML 檔案 | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| 預覽 Mermaid 檔案 | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| 預覽 D2 檔案 | `Cmd+Alt+V` | `Ctrl+Alt+V` |

## 常見問題

<details>
<summary><strong>PlantUML 圖表無法渲染</strong></summary>

**Fast/Secure 模式：**

1. 執行 `java -version` 確認已安裝 Java 11 或更高版本
2. 如使用類別圖、元件圖等，執行 `dot -V` 確認已安裝 Graphviz
3. 查看 VS Code 輸出面板中的錯誤訊息

**Easy 模式：**

1. 確認伺服器 URL 正確（預設：`https://www.plantuml.com/plantuml`）
2. 確認網路連線正常

</details>

<details>
<summary><strong>可以不安裝 Java 使用 PlantUML 嗎？</strong></summary>

可以。在擴充功能設定中將 `mode` 設為 `"easy"`。Easy 模式將 PlantUML 文字傳送至 PlantUML 伺服器渲染，無需 Java。

</details>

<details>
<summary><strong><code>!include</code> 無法運作</strong></summary>

`!include` 需要 Fast 或 Secure 模式 — Easy 模式不可用，因為遠端伺服器無法存取本機檔案。

</details>

## 貢獻

開發環境設定、建置說明和 PR 指南請參閱 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 第三方授權

此擴充功能包含以下第三方軟體：

- [PlantUML](https://plantuml.com/)（LGPL 版本）— [GNU Lesser General Public License v3 (LGPL-3.0)](https://www.gnu.org/licenses/lgpl-3.0.html)
- [mermaid.js](https://mermaid.js.org/) — [MIT License](https://github.com/mermaid-js/mermaid/blob/develop/LICENSE)
- [KaTeX](https://katex.org/) — [MIT License](https://github.com/KaTeX/KaTeX/blob/main/LICENSE)
- [@terrastruct/d2](https://d2lang.com/)（Wasm 建置）— [Mozilla Public License 2.0 (MPL-2.0)](https://github.com/terrastruct/d2/blob/master/LICENSE.txt)

## 授權

[MIT](LICENSE)
