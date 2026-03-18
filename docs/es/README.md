<p align="center">
  <a href="#/">English</a> | <a href="#/zh-cn/">简体中文</a> | <a href="#/zh-tw/">繁體中文</a> | <a href="#/ko/">한국어</a> | <a href="#/ja/">日本語</a> | <strong>Español</strong> | <a href="#/pt-br/">Português</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/yss-tazawa/plantuml-markdown-preview/main/images/icon_512.png" width="128" alt="PlantUML Markdown Preview">
</p>

<h1 align="center">PlantUML Markdown Preview</h1>

<p align="center">
  <strong>3 modos para tu flujo de trabajo. Renderiza PlantUML, Mermaid y D2 en línea — rápido, seguro o sin configuración.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/v/yss-tazawa.plantuml-markdown-preview" alt="VS Marketplace Version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yss-tazawa.plantuml-markdown-preview"><img src="https://img.shields.io/visual-studio-marketplace/i/yss-tazawa.plantuml-markdown-preview" alt="Installs"></a>
  <a href="https://github.com/yss-tazawa/plantuml-markdown-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yss-tazawa/plantuml-markdown-preview" alt="License: MIT"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/yss-tazawa/plantuml-markdown-preview/main/images/hero-screenshot.png" width="800" alt="Editor y vista previa en paralelo con tema GitHub Light mostrando un diagrama de secuencia">
</p>

## Elige tu Modo

| | **Fast** (predeterminado) | **Secure** | **Easy** |
| --- | --- | --- | --- |
| | Re-renderizados instantáneos | Máxima privacidad | Sin configuración |
| | Ejecuta servidor PlantUML en localhost — sin costo de inicio JVM | Sin red, sin procesos en segundo plano | Sin Java — funciona con servidor PlantUML |
| **Java** | 11+ requerido | 11+ requerido | No requerido |
| **Red** | Ninguna | Ninguna | Requerida |
| **Privacidad** | Solo local | Solo local | Fuente enviada al servidor PlantUML |
| **Configuración** | [Instalar Java →](#prerequisites) | [Instalar Java →](#prerequisites) | Sin configuración |

Cambia entre modos en cualquier momento con una sola configuración — sin migración, sin reinicio.

## Características Principales

- **Renderizado en línea de PlantUML, Mermaid y D2** — los diagramas aparecen directamente en la vista previa de Markdown, no en un panel separado
- **Diseño seguro** — política CSP basada en nonce bloquea toda ejecución de código del contenido Markdown
- **Control de escala de diagramas** — ajusta los tamaños de PlantUML, Mermaid y D2 de forma independiente
- **Exportación HTML autocontenida** — SVGs incrustados en línea, ancho de diseño y alineación configurables
- **Exportación PDF** — exportación con un clic vía Chromium headless; diagramas se escalan automáticamente
- **Sincronización de scroll bidireccional** — el editor y la vista previa se desplazan juntos en ambas direcciones
- **Navegación e índice** — botones ir arriba/abajo y barra lateral de tabla de contenidos en el panel de vista previa
- **Visor de Diagramas** — clic derecho en cualquier diagrama para abrir panel de pan y zoom con sincronización en tiempo real
- **Vista previa independiente de diagrama** — abre archivos `.puml`, `.mmd`, `.d2` directamente con pan y zoom, actualizaciones en vivo y soporte de temas
- **Guardar/copiar diagrama como PNG/SVG** — clic derecho en diagrama para guardar o copiar al portapapeles
- **14 temas de vista previa** — 8 claros + 6 oscuros (GitHub, Atom, Solarized, Dracula, Monokai etc.)
- **Asistencia del editor** — autocompletado de palabras clave, selector de color y snippets para PlantUML, Mermaid y D2
- **Internacionalización** — interfaz en inglés, chino (simplificado / tradicional), japonés, coreano, español y portugués brasileño
- **Soporte de fórmulas matemáticas** — renderiza `$...$` en línea y `$$...$$` en bloque con [KaTeX](https://katex.org/)

## Funcionalidades

### Vista Previa de Diagramas en Línea

Los bloques ```` ```plantuml ````、```` ```mermaid ```` y ```` ```d2 ```` se renderizan como diagramas SVG en línea junto con el contenido Markdown normal.

- Actualización de vista previa en tiempo real al escribir (debounce en dos etapas)
- Actualización automática al guardar el archivo
- PlantUML: renderizado via Java (modos Secure/Fast) o servidor PlantUML remoto (modo Easy)
- Mermaid: renderizado en el cliente con [mermaid.js](https://mermaid.js.org/) — sin Java ni herramientas externas
- D2: renderizado con [@terrastruct/d2](https://d2lang.com/) (Wasm) — sin herramientas externas

### Modos de Renderizado

| | Fast (predeterminado) | Secure | Easy |
| --- | --- | --- | --- |
| **Java requerido** | Sí | Sí | No |
| **Red** | Ninguna (solo localhost) | Ninguna | Requerida |
| **Privacidad** | Diagramas permanecen locales | Diagramas permanecen locales | Fuente enviada al servidor PlantUML |
| **Velocidad** | Servidor residente — re-renderizado instantáneo | Inicia JVM en cada renderizado | Depende de la red |

- **Modo Fast** (predeterminado) — Inicia servidor PlantUML residente en `localhost`. Elimina el costo de inicio de JVM en cada edición.
- **Modo Secure** — Usa Java + PlantUML jar localmente. Sin acceso a red.
- **Modo Easy** — Envía fuente PlantUML al servidor para renderizar. Sin configuración necesaria.

### Visor de Diagramas

Haz clic derecho en cualquier diagrama en la vista previa y selecciona **Abrir en Visor de Diagramas** para abrir un panel dedicado de pan y zoom.

- Zoom con rueda del mouse (centrado en cursor), arrastrar para pan
- Sincronización en tiempo real, posición de zoom preservada
- **Guardar/copiar como PNG/SVG** — clic derecho para guardar archivo o copiar al portapapeles

### Temas

**Temas claros:** GitHub Light (predeterminado), Atom Light, One Light, Solarized Light, Vue, Pen Paper Coffee, Coy, VS

**Temas oscuros:** GitHub Dark, Atom Dark, One Dark, Dracula, Solarized Dark, Monokai

## Inicio Rápido

### Prerrequisitos

**Mermaid / D2** — sin prerrequisitos. Funciona de inmediato.

**PlantUML (modo Easy)** — sin prerrequisitos.

**PlantUML (modos Fast/Secure):**

| Herramienta | Propósito | Verificar |
| --- | --- | --- |
| Java 11+ (JRE o JDK) | Ejecutar PlantUML | `java -version` |
| [Graphviz](https://graphviz.org/) | Opcional — necesario para diagramas de clase, componente etc. | `dot -V` |

### Instalación

1. Abre VS Code
2. En la vista de Extensiones (`Ctrl+Shift+X` / `Cmd+Shift+X`), busca **PlantUML Markdown Preview**
3. Haz clic en **Instalar**

### Ajuste Inicial

**Modo Fast** (predeterminado): Inicia servidor PlantUML local residente. Requiere Java 11+.

**Usar modo Secure**: Establece `mode` como `"secure"`.

**Usar modo Easy** (sin configuración): Establece `mode` como `"easy"`.

#### Windows

1. Instala Java (PowerShell):

   ```powershell
   winget install Microsoft.OpenJDK.21
   ```

2. Descarga [PlantUML versión GPLv2](https://plantuml.com/download) (`plantuml-gplv2-*.jar`)
3. En configuración de VS Code (`Ctrl+,`), establece `plantumlMarkdownPreview.plantumlJarPath` con la ruta del jar

#### Mac

```sh
brew install openjdk graphviz
```

#### Linux

```sh
sudo apt install default-jdk graphviz
```

## Cómo Usar

### Abrir Vista Previa

- **Atajo:** `Cmd+Alt+V` (Mac) / `Ctrl+Alt+V` (Windows/Linux)
- **Menú contextual:** Clic derecho en archivo `.md` → **PlantUML Markdown Preview** → **Abrir Vista Previa al Lado**

### Exportar HTML / PDF

- Clic derecho en archivo `.md` → **PlantUML Markdown Preview** → **Exportar como HTML** o **Exportar como PDF**
- La exportación PDF requiere Chrome, Edge o Chromium

### Cambiar Tema

Haz clic en el icono de tema en la barra de título del panel de vista previa, o usa la Paleta de Comandos: `PlantUML Markdown Preview: Change Preview Theme`

## Configuración

Todas las configuraciones usan el prefijo `plantumlMarkdownPreview.`.

| Configuración | Valor predeterminado | Descripción |
| --- | --- | --- |
| `mode` | `"fast"` | Modo de renderizado. `"fast"`, `"secure"`, `"easy"` |
| `javaPath` | `"java"` | Ruta al ejecutable de Java |
| `plantumlJarPath` | `""` | Ruta a plantuml.jar. Vacío usa el jar incluido |
| `dotPath` | `"dot"` | Ruta al ejecutable dot de Graphviz |
| `previewTheme` | `"github-light"` | Tema de la vista previa |
| `plantumlTheme` | `"default"` | Tema de diagramas PlantUML |
| `mermaidTheme` | `"default"` | Tema de diagramas Mermaid |
| `plantumlScale` | `"100%"` | Escala de diagramas PlantUML |
| `mermaidScale` | `"80%"` | Escala de diagramas Mermaid |
| `d2Theme` | `"Neutral Default"` | Tema de diagramas D2 |
| `d2Scale` | `"75%"` | Escala de diagramas D2 |
| `htmlMaxWidth` | `"960px"` | Ancho máximo del HTML exportado |
| `enableMath` | `true` | Activar renderizado matemático KaTeX |
| `plantumlServerUrl` | `"https://www.plantuml.com/plantuml"` | URL del servidor PlantUML para modo Easy |

## Atajos de Teclado

| Comando | Mac | Windows / Linux |
| --- | --- | --- |
| Abrir Vista Previa al Lado (Markdown) | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| Vista previa de archivo PlantUML | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| Vista previa de archivo Mermaid | `Cmd+Alt+V` | `Ctrl+Alt+V` |
| Vista previa de archivo D2 | `Cmd+Alt+V` | `Ctrl+Alt+V` |

## Preguntas Frecuentes

<details>
<summary><strong>Los diagramas PlantUML no se renderizan</strong></summary>

**Modos Fast/Secure:**

1. Ejecuta `java -version` para confirmar que Java 11 o superior está instalado
2. Para diagramas de clase/componente, ejecuta `dot -V` para confirmar que Graphviz está instalado
3. Revisa el panel de Salida de VS Code para mensajes de error

**Modo Easy:**

1. Verifica que la URL del servidor sea correcta (predeterminado: `https://www.plantuml.com/plantuml`)
2. Verifica la conexión de red

</details>

<details>
<summary><strong>¿Puedo usar PlantUML sin instalar Java?</strong></summary>

Sí. Establece `mode` como `"easy"` en la configuración. El modo Easy envía el texto PlantUML a un servidor para renderizar y no requiere Java.

</details>

<details>
<summary><strong><code>!include</code> no funciona</strong></summary>

`!include` requiere el modo Fast o Secure — no funciona en el modo Easy porque el servidor remoto no puede acceder a archivos locales.

</details>

## Contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para la configuración del entorno de desarrollo, instrucciones de build y pautas de pull request.

## Licencias de Terceros

Esta extensión incluye el siguiente software de terceros:

- [PlantUML](https://plantuml.com/) (versión LGPL) — [GNU Lesser General Public License v3 (LGPL-3.0)](https://www.gnu.org/licenses/lgpl-3.0.html)
- [mermaid.js](https://mermaid.js.org/) — [MIT License](https://github.com/mermaid-js/mermaid/blob/develop/LICENSE)
- [KaTeX](https://katex.org/) — [MIT License](https://github.com/KaTeX/KaTeX/blob/main/LICENSE)
- [@terrastruct/d2](https://d2lang.com/) (build Wasm) — [Mozilla Public License 2.0 (MPL-2.0)](https://github.com/terrastruct/d2/blob/master/LICENSE.txt)

## Licencia

[MIT](LICENSE)
