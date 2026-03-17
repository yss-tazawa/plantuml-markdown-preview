<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-cn.md">简体中文</a> | <a href="README.zh-tw.md">繁體中文</a> | <strong>한국어</strong> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.pt-br.md">Português</a>
</p>

<p align="center">
  <img src="images/icon_512.png" width="128" alt="PlantUML Markdown Preview">
</p>

<h1 align="center">PlantUML Markdown Preview</h1>

<p align="center">
  <strong>워크플로에 맞는 3가지 모드. PlantUML, Mermaid, D2를 인라인으로 렌더링 — 빠르게, 안전하게, 또는 설정 없이.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/v/yss-tazawa.plantuml-markdown-preview" alt="VS Marketplace Version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/i/yss-tazawa.plantuml-markdown-preview" alt="Installs"></a>
  <a href="https://github.com/yss-tazawa/plantuml-markdown-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yss-tazawa/plantuml-markdown-preview" alt="License: MIT"></a>
</p>

<p align="center">
  <img src="images/hero-screenshot.png" width="800" alt="GitHub Light 테마에서 시퀀스 다이어그램을 보여주는 편집기와 미리보기 나란히 표시">
</p>

## 모드 선택

| | **Fast** (기본값) | **Secure** | **Easy** |
| --- | --- | --- | --- |
| | 즉시 재렌더링 | 최고의 프라이버시 | 설정 불필요 |
| | localhost에서 PlantUML 서버 실행 — JVM 시작 비용 없음 | 네트워크 없음, 백그라운드 프로세스 없음 | Java 불필요 — PlantUML 서버로 즉시 사용 |
| **Java** | 11+ 필요 | 11+ 필요 | 불필요 |
| **네트워크** | 없음 | 없음 | 필요 |
| **프라이버시** | 로컬만 | 로컬만 | 다이어그램 소스가 PlantUML 서버로 전송 |
| **설정** | [Java 설치 →](#prerequisites) | [Java 설치 →](#prerequisites) | 설정 불필요 |

설정 하나로 언제든 모드 전환 — 마이그레이션, 재시작 불필요.

## 주요 기능

- **PlantUML, Mermaid, D2 인라인 렌더링** — 다이어그램이 별도 패널이 아닌 Markdown 미리보기에 직접 표시
- **보안 설계** — CSP nonce 기반 정책으로 Markdown 콘텐츠의 모든 코드 실행 차단
- **다이어그램 크기 조절** — PlantUML, Mermaid, D2 다이어그램 크기를 개별 조정
- **자체 포함 HTML 내보내기** — SVG 다이어그램 인라인 임베드, 레이아웃 너비 및 정렬 설정 가능
- **PDF 내보내기** — 헤드리스 Chromium으로 원클릭 내보내기, 다이어그램 자동 크기 조정
- **양방향 스크롤 동기화** — 편집기와 미리보기가 양방향 연동 스크롤
- **탐색 및 목차** — 맨 위/맨 아래 이동 버튼과 미리보기 패널의 목차 사이드바
- **다이어그램 뷰어** — 다이어그램 우클릭으로 팬&줌 패널 열기, 실시간 동기화 및 테마 배경 적용
- **독립 다이어그램 미리보기** — `.puml`, `.mmd`, `.d2` 파일을 팬&줌, 실시간 업데이트, 테마 지원으로 직접 미리보기
- **다이어그램을 PNG/SVG로 저장/복사** — 미리보기 또는 다이어그램 뷰어에서 우클릭하여 저장 또는 클립보드 복사
- **14가지 미리보기 테마** — 밝은 테마 8개 + 어두운 테마 6개 (GitHub, Atom, Solarized, Dracula, Monokai 등)
- **에디터 지원** — PlantUML, Mermaid, D2 키워드 자동완성, 색상 선택기, 코드 스니펫
- **국제화** — 영어, 중국어(간체), 일본어 UI 지원
- **수식 지원** — [KaTeX](https://katex.org/)로 `$...$` 인라인 수식과 `$$...$$` 블록 수식 렌더링

## 기능

### 인라인 다이어그램 미리보기

```` ```plantuml ````、```` ```mermaid ````、```` ```d2 ```` 코드 블록이 일반 Markdown 콘텐츠와 함께 인라인 SVG 다이어그램으로 렌더링됩니다.

- 입력 시 실시간 미리보기 업데이트 (2단계 디바운스)
- 파일 저장 시 자동 업데이트
- 편집기 탭 전환 시 자동 추적
- PlantUML: Java (Secure/Fast 모드) 또는 원격 PlantUML 서버 (Easy 모드)로 렌더링
- Mermaid: [mermaid.js](https://mermaid.js.org/)로 클라이언트 사이드 렌더링
- D2: [@terrastruct/d2](https://d2lang.com/) (Wasm)로 클라이언트 사이드 렌더링

### 렌더링 모드

| | Fast (기본값) | Secure | Easy |
| --- | --- | --- | --- |
| **Java 필요** | 예 | 예 | 아니요 |
| **네트워크** | 없음 (localhost만) | 없음 | 필요 |
| **프라이버시** | 다이어그램이 로컬에 유지 | 다이어그램이 로컬에 유지 | 소스가 PlantUML 서버로 전송 |
| **속도** | 상주 서버 — 즉시 재렌더링 | 렌더링마다 JVM 시작 | 네트워크에 의존 |

- **Fast 모드** (기본값) — `localhost`에서 상주 PlantUML 서버 시작. JVM 시작 비용 없이 즉시 재렌더링.
- **Secure 모드** — Java + PlantUML jar를 로컬에서 사용. 네트워크 접근 없음.
- **Easy 모드** — PlantUML 소스를 서버로 전송하여 렌더링. 설정 불필요.

### 다이어그램 뷰어

미리보기에서 다이어그램을 우클릭하고 **다이어그램 뷰어에서 열기**를 선택하면 팬&줌 전용 패널이 열립니다.

- 마우스 휠 줌 (커서 중심), 드래그로 팬
- 실시간 동기화, 줌 위치 유지
- **PNG/SVG로 저장/복사** — 우클릭으로 파일 저장 또는 클립보드 복사

### 테마

**미리보기 테마** — 밝은 테마: GitHub Light (기본값), Atom Light, One Light, Solarized Light, Vue, Pen Paper Coffee, Coy, VS

**어두운 테마:** GitHub Dark, Atom Dark, One Dark, Dracula, Solarized Dark, Monokai

## 빠른 시작

### 사전 요구 사항

**Mermaid / D2** — 사전 요구 사항 없음. 바로 사용 가능.

**PlantUML (Easy 모드)** — 사전 요구 사항 없음.

**PlantUML (Fast/Secure 모드):**

| 도구 | 용도 | 확인 |
| --- | --- | --- |
| Java 11+ (JRE 또는 JDK) | PlantUML 실행 | `java -version` |
| [Graphviz](https://graphviz.org/) | 선택 사항 — 클래스, 컴포넌트 등 다이어그램에 필요 | `dot -V` |

### 설치

1. VS Code 열기
2. 확장 프로그램 뷰 (`Ctrl+Shift+X` / `Cmd+Shift+X`)에서 **PlantUML Markdown Preview** 검색
3. **설치** 클릭

### 설정 방법

**Fast 모드** (기본값): 상주 로컬 PlantUML 서버 시작. Java 11+ 필요.

**Secure 모드 사용**: `mode`를 `"secure"`로 설정.

**Easy 모드 사용** (설정 불필요): `mode`를 `"easy"`로 설정.

#### Windows

1. Java 설치 (PowerShell):

   ```powershell
   winget install Microsoft.OpenJDK.21
   ```

2. [GPLv2 버전 PlantUML](https://plantuml.com/download) (`plantuml-gplv2-*.jar`) 다운로드
3. VS Code 설정 (`Ctrl+,`)에서 `plantumlMarkdownPreview.plantumlJarPath`에 jar 경로 입력

#### Mac

```sh
brew install openjdk graphviz
```

#### Linux

```sh
sudo apt install default-jdk graphviz
```

## 사용 방법

### 미리보기 열기

- **단축키:** `Cmd+Alt+V` (Mac) / `Ctrl+Alt+V` (Windows/Linux)
- **우클릭 메뉴:** `.md` 파일 우클릭 → **PlantUML Markdown Preview** → **미리보기를 옆에 열기**

### HTML / PDF 내보내기

- `.md` 파일 우클릭 → **PlantUML Markdown Preview** → **HTML로 내보내기** 또는 **PDF로 내보내기**
- PDF 내보내기는 Chrome, Edge 또는 Chromium 필요

## 설정

모든 설정은 `plantumlMarkdownPreview.` 접두사를 사용합니다.

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `mode` | `"fast"` | 렌더링 모드. `"fast"`, `"secure"`, `"easy"` |
| `javaPath` | `"java"` | Java 실행 파일 경로 |
| `plantumlJarPath` | `""` | plantuml.jar 경로. 비워두면 내장 jar 사용 |
| `dotPath` | `"dot"` | Graphviz dot 실행 파일 경로 |
| `previewTheme` | `"github-light"` | 미리보기 테마 |
| `plantumlTheme` | `"default"` | PlantUML 다이어그램 테마 |
| `mermaidTheme` | `"default"` | Mermaid 다이어그램 테마 |
| `plantumlScale` | `"100%"` | PlantUML 다이어그램 크기 |
| `mermaidScale` | `"80%"` | Mermaid 다이어그램 크기 |
| `d2Theme` | `"Neutral Default"` | D2 다이어그램 테마 |
| `d2Scale` | `"75%"` | D2 다이어그램 크기 |
| `htmlMaxWidth` | `"960px"` | HTML 내보내기 최대 너비 |
| `enableMath` | `true` | KaTeX 수식 렌더링 활성화 |
| `plantumlServerUrl` | `"https://www.plantuml.com/plantuml"` | Easy 모드 PlantUML 서버 URL |

## 키보드 단축키

| 명령 | Mac | Windows / Linux |
| --- | --- | --- |
| 옆에 미리보기 열기 (Markdown) | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| PlantUML 파일 미리보기 | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| Mermaid 파일 미리보기 | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| D2 파일 미리보기 | `Cmd+Alt+V` | `Ctrl+Alt+V` |

## 자주 묻는 질문

<details>
<summary><strong>PlantUML 다이어그램이 렌더링되지 않음</strong></summary>

**Fast/Secure 모드:**

1. `java -version`으로 Java 11 이상 설치 확인
2. 클래스, 컴포넌트 다이어그램 사용 시 `dot -V`로 Graphviz 설치 확인
3. VS Code 출력 패널에서 오류 메시지 확인

**Easy 모드:**

1. 서버 URL 확인 (기본값: `https://www.plantuml.com/plantuml`)
2. 네트워크 연결 확인

</details>

<details>
<summary><strong>Java 없이 PlantUML을 사용할 수 있나요?</strong></summary>

네. 설정에서 `mode`를 `"easy"`로 설정하세요. Easy 모드는 Java 없이 PlantUML 서버로 렌더링합니다.

</details>

<details>
<summary><strong><code>!include</code>가 작동하지 않음</strong></summary>

`!include`는 Fast 또는 Secure 모드가 필요합니다. Easy 모드에서는 원격 서버가 로컬 파일에 접근할 수 없어 사용 불가합니다.

</details>

## 기여

개발 환경 설정, 빌드 방법, PR 가이드라인은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

## 서드파티 라이선스

이 확장 프로그램에는 다음 서드파티 소프트웨어가 포함되어 있습니다:

- [PlantUML](https://plantuml.com/) (LGPL 버전) — [GNU Lesser General Public License v3 (LGPL-3.0)](https://www.gnu.org/licenses/lgpl-3.0.html)
- [mermaid.js](https://mermaid.js.org/) — [MIT License](https://github.com/mermaid-js/mermaid/blob/develop/LICENSE)
- [KaTeX](https://katex.org/) — [MIT License](https://github.com/KaTeX/KaTeX/blob/main/LICENSE)
- [@terrastruct/d2](https://d2lang.com/) (Wasm 빌드) — [Mozilla Public License 2.0 (MPL-2.0)](https://github.com/terrastruct/d2/blob/master/LICENSE.txt)

## 라이선스

[MIT](LICENSE)
