<p align="center">
  <a href="https://yss-tazawa.github.io/plantuml-markdown-preview/">English</a> | <a href="https://yss-tazawa.github.io/plantuml-markdown-preview/#/zh-cn/">简体中文</a> | <a href="https://yss-tazawa.github.io/plantuml-markdown-preview/#/zh-tw/">繁體中文</a> | <a href="https://yss-tazawa.github.io/plantuml-markdown-preview/#/ko/">한국어</a> | <a href="https://yss-tazawa.github.io/plantuml-markdown-preview/#/ja/">日本語</a> | <a href="https://yss-tazawa.github.io/plantuml-markdown-preview/#/es/">Español</a> | <strong>Português</strong>
</p>

<p align="center">
  <img src="images/icon_512.png" width="128" alt="PlantUML Markdown Preview">
</p>

<h1 align="center">PlantUML Markdown Preview</h1>

<p align="center">
  <strong>3 modos para o seu fluxo de trabalho. Renderize PlantUML, Mermaid e D2 inline — rápido, seguro ou sem configuração.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/v/yss-tazawa.plantuml-markdown-preview" alt="VS Marketplace Version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/i/yss-tazawa.plantuml-markdown-preview" alt="Installs"></a>
  <a href="https://github.com/yss-tazawa/plantuml-markdown-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yss-tazawa/plantuml-markdown-preview" alt="License: MIT"></a>
</p>

<p align="center">
  <img src="images/hero-screenshot.png" width="800" alt="Editor e preview lado a lado no tema GitHub Light mostrando um diagrama de sequência">
</p>

## Escolha seu Modo

| | **Fast** (padrão) | **Secure** | **Easy** |
| --- | --- | --- | --- |
| | Re-renderizações instantâneas | Máxima privacidade | Zero configuração |
| | Executa servidor PlantUML no localhost — sem custo de inicialização JVM | Sem rede, sem processos em segundo plano | Sem Java — funciona com servidor PlantUML |
| **Java** | 11+ necessário | 11+ necessário | Não necessário |
| **Rede** | Nenhuma | Nenhuma | Necessária |
| **Privacidade** | Apenas local | Apenas local | Fonte enviada ao servidor PlantUML |
| **Configuração** | [Instalar Java →](#prerequisites) | [Instalar Java →](#prerequisites) | Sem configuração |

Alterne entre modos a qualquer momento com uma única configuração — sem migração, sem reinicialização.

## Destaques

- **Renderização inline de PlantUML, Mermaid e D2** — diagramas aparecem diretamente no preview do Markdown, não em painel separado
- **Design seguro** — política CSP baseada em nonce bloqueia toda execução de código do conteúdo Markdown
- **Controle de escala de diagramas** — ajuste os tamanhos de PlantUML, Mermaid e D2 independentemente
- **Exportação HTML auto-contida** — SVGs embutidos inline, largura de layout e alinhamento configuráveis
- **Exportação PDF** — exportação com um clique via Chromium headless; diagramas são redimensionados automaticamente
- **Sincronização de scroll bidirecional** — editor e preview rolam juntos, nos dois sentidos
- **Navegação e índice** — botões ir ao topo/rodapé e barra lateral de sumário no painel de preview
- **Visualizador de Diagramas** — clique direito em qualquer diagrama para abrir painel de pan e zoom com sincronização em tempo real
- **Preview independente de diagrama** — abra arquivos `.puml`, `.mmd`, `.d2` diretamente com pan e zoom, atualizações ao vivo e suporte a temas
- **Salvar/copiar diagrama como PNG/SVG** — clique direito em diagrama no preview ou visualizador para salvar ou copiar para área de transferência
- **14 temas de preview** — 8 claros + 6 escuros (GitHub, Atom, Solarized, Dracula, Monokai etc.)
- **Assistência do editor** — autocompletar palavras-chave, seletor de cores e snippets para PlantUML, Mermaid e D2
- **Internacionalização** — interface em inglês, chinês (simplificado / tradicional), japonês, coreano, espanhol e português brasileiro
- **Suporte a fórmulas matemáticas** — renderiza `$...$` inline e `$$...$$` em bloco com [KaTeX](https://katex.org/)

## Funcionalidades

### Preview de Diagramas Inline

Blocos ```` ```plantuml ````、```` ```mermaid ```` e ```` ```d2 ```` são renderizados como diagramas SVG inline junto com o conteúdo Markdown normal.

- Atualização do preview em tempo real ao digitar (debounce em duas etapas)
- Atualização automática ao salvar o arquivo
- Segue automaticamente ao trocar abas do editor
- PlantUML: renderizado via Java (modos Secure/Fast) ou servidor PlantUML remoto (modo Easy)
- Mermaid: renderizado no lado do cliente com [mermaid.js](https://mermaid.js.org/) — sem Java ou ferramentas externas
- D2: renderizado com [@terrastruct/d2](https://d2lang.com/) (Wasm) — sem ferramentas externas

### Modos de Renderização

| | Fast (padrão) | Secure | Easy |
| --- | --- | --- | --- |
| **Java necessário** | Sim | Sim | Não |
| **Rede** | Nenhuma (apenas localhost) | Nenhuma | Necessária |
| **Privacidade** | Diagramas ficam locais | Diagramas ficam locais | Fonte enviada ao servidor PlantUML |
| **Velocidade** | Servidor PlantUML residente — re-renderização instantânea | Inicia JVM a cada renderização | Depende da rede |

- **Modo Fast** (padrão) — Inicia servidor PlantUML residente no `localhost`. Elimina o custo de inicialização JVM a cada edição.
- **Modo Secure** — Usa Java + PlantUML jar localmente. Sem acesso à rede.
- **Modo Easy** — Envia fonte PlantUML ao servidor para renderização. Sem configuração necessária.

### Visualizador de Diagramas

Clique direito em qualquer diagrama PlantUML/Mermaid/D2 no preview e selecione **Abrir no Visualizador de Diagramas** para abrir em painel dedicado de pan e zoom.

- Zoom com roda do mouse (centrado no cursor), arrastar para pan
- Barra de ferramentas: ajustar à janela, reset 1:1, zoom por passos (+/−)
- Sincronização em tempo real, posição de zoom preservada
- **Salvar/copiar como PNG/SVG** — clique direito para salvar arquivo ou copiar para área de transferência

### Temas

**Temas claros:** GitHub Light (padrão), Atom Light, One Light, Solarized Light, Vue, Pen Paper Coffee, Coy, VS

**Temas escuros:** GitHub Dark, Atom Dark, One Dark, Dracula, Solarized Dark, Monokai

## Início Rápido

### Pré-requisitos

**Mermaid / D2** — sem pré-requisitos. Funciona imediatamente.

**PlantUML (modo Easy)** — sem pré-requisitos.

**PlantUML (modos Fast/Secure):**

| Ferramenta | Finalidade | Verificar |
| --- | --- | --- |
| Java 11+ (JRE ou JDK) | Executar PlantUML | `java -version` |
| [Graphviz](https://graphviz.org/) | Opcional — necessário para diagramas de classe, componente etc. | `dot -V` |

### Instalação

1. Abra o VS Code
2. Na aba de Extensões (`Ctrl+Shift+X` / `Cmd+Shift+X`), pesquise **PlantUML Markdown Preview**
3. Clique em **Instalar**

### Configuração

**Modo Fast** (padrão): Inicia servidor PlantUML local residente. Requer Java 11+.

**Usar modo Secure**: Defina `mode` como `"secure"`.

**Usar modo Easy** (sem configuração): Defina `mode` como `"easy"`.

#### Windows

1. Instale o Java (PowerShell):

   ```powershell
   winget install Microsoft.OpenJDK.21
   ```

2. Baixe o [PlantUML versão GPLv2](https://plantuml.com/download) (`plantuml-gplv2-*.jar`)
3. Nas configurações do VS Code (`Ctrl+,`), defina `plantumlMarkdownPreview.plantumlJarPath` com o caminho do jar

#### Mac

```sh
brew install openjdk graphviz
```

#### Linux

```sh
sudo apt install default-jdk graphviz
```

## Como Usar

### Abrir Preview

- **Atalho:** `Cmd+Alt+V` (Mac) / `Ctrl+Alt+V` (Windows/Linux)
- **Menu de contexto:** Clique direito em arquivo `.md` → **PlantUML Markdown Preview** → **Abrir Preview ao Lado**

### Exportar HTML / PDF

- Clique direito em arquivo `.md` → **PlantUML Markdown Preview** → **Exportar como HTML** ou **Exportar como PDF**
- Exportação PDF requer Chrome, Edge ou Chromium

### Alterar Tema

Clique no ícone de tema na barra de título do painel de preview, ou use a Paleta de Comandos: `PlantUML Markdown Preview: Change Preview Theme`

## Configurações

Todas as configurações usam o prefixo `plantumlMarkdownPreview.`.

| Configuração | Padrão | Descrição |
| --- | --- | --- |
| `mode` | `"fast"` | Modo de renderização. `"fast"`, `"secure"`, `"easy"` |
| `javaPath` | `"java"` | Caminho para o executável Java |
| `plantumlJarPath` | `""` | Caminho para plantuml.jar. Vazio usa jar embutido |
| `dotPath` | `"dot"` | Caminho para o executável dot do Graphviz |
| `previewTheme` | `"github-light"` | Tema do preview |
| `plantumlTheme` | `"default"` | Tema dos diagramas PlantUML |
| `mermaidTheme` | `"default"` | Tema dos diagramas Mermaid |
| `plantumlScale` | `"100%"` | Escala dos diagramas PlantUML |
| `mermaidScale` | `"80%"` | Escala dos diagramas Mermaid |
| `d2Theme` | `"Neutral Default"` | Tema dos diagramas D2 |
| `d2Scale` | `"75%"` | Escala dos diagramas D2 |
| `htmlMaxWidth` | `"960px"` | Largura máxima do HTML exportado |
| `enableMath` | `true` | Ativar renderização matemática KaTeX |
| `plantumlServerUrl` | `"https://www.plantuml.com/plantuml"` | URL do servidor PlantUML para modo Easy |

## Atalhos de Teclado

| Comando | Mac | Windows / Linux |
| --- | --- | --- |
| Abrir Preview ao Lado (Markdown) | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| Preview de arquivo PlantUML | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| Preview de arquivo Mermaid | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| Preview de arquivo D2 | `Cmd+Alt+V` | `Ctrl+Alt+V` |

## Perguntas Frequentes

<details>
<summary><strong>Diagramas PlantUML não estão renderizando</strong></summary>

**Modos Fast/Secure:**

1. Execute `java -version` para confirmar Java 11 ou superior instalado
2. Para diagramas de classe/componente, execute `dot -V` para confirmar Graphviz instalado
3. Verifique o painel de Saída do VS Code para mensagens de erro

**Modo Easy:**

1. Verifique se a URL do servidor está correta (padrão: `https://www.plantuml.com/plantuml`)
2. Verifique a conexão de rede

</details>

<details>
<summary><strong>Posso usar PlantUML sem instalar Java?</strong></summary>

Sim. Defina `mode` como `"easy"` nas configurações. O modo Easy envia o texto PlantUML a um servidor para renderização e não requer Java.

</details>

<details>
<summary><strong><code>!include</code> não está funcionando</strong></summary>

`!include` requer o modo Fast ou Secure — não funciona no modo Easy porque o servidor remoto não pode acessar arquivos locais.

</details>

## Contribuindo

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para configuração do ambiente de desenvolvimento, instruções de build e diretrizes de pull request.

## Licenças de Terceiros

Esta extensão inclui os seguintes softwares de terceiros:

- [PlantUML](https://plantuml.com/) (versão LGPL) — [GNU Lesser General Public License v3 (LGPL-3.0)](https://www.gnu.org/licenses/lgpl-3.0.html)
- [mermaid.js](https://mermaid.js.org/) — [MIT License](https://github.com/mermaid-js/mermaid/blob/develop/LICENSE)
- [KaTeX](https://katex.org/) — [MIT License](https://github.com/KaTeX/KaTeX/blob/main/LICENSE)
- [@terrastruct/d2](https://d2lang.com/) (build Wasm) — [Mozilla Public License 2.0 (MPL-2.0)](https://github.com/terrastruct/d2/blob/master/LICENSE.txt)

## Licença

[MIT](LICENSE)
