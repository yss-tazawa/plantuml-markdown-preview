/**
 * @module revision-preview
 * @description Read-only preview of a Markdown file at a Git revision.
 *
 * Opens beside the ordinary preview so a changed diagram can be compared rendered,
 * side by side, instead of by reading PlantUML source in a text diff.
 *
 * Deliberately separate from PreviewManager. A revision is a fixed snapshot: it never
 * changes, has no editor to scroll with, and must not be confused with the file being
 * edited. Keeping it apart means none of the live-preview machinery — scroll sync,
 * debounced re-render, save and change handlers — applies or can regress.
 */
import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs';
import { renderHtmlAsync } from './exporter.js';
import { getNonce, escapeHtml, errorHtml, resolveLocalImagePaths } from './utils.js';
import { readFileAtRevision, findRepositoryRoot, isGitAvailable, type Revision } from './git.js';
import type { Config } from './config.js';

/** View type for the revision preview panels. */
const VIEW_TYPE = 'plantumlMarkdownRevisionPreview';

/** Open panels keyed by `<filePath>\n<ref>` so re-running the command reuses a panel. */
const panels = new Map<string, vscode.WebviewPanel>();

/** Key identifying one file-at-revision panel. */
function panelKey(filePath: string, revision: Revision): string {
    return `${filePath}\n${revision.ref}`;
}

/** Build the panel title, e.g. `design.md (HEAD)`. */
function makeTitle(filePath: string, revision: Revision): string {
    return `${path.basename(filePath)} (${revision.label})`;
}

/** Roots the webview may load local files from. Mirrors the live preview: the workspace
 *  folder when the file is inside one, otherwise the file's own directory. Without this
 *  the webview blocks every local image the document references. */
function buildLocalResourceRoots(filePath: string, config: Config): vscode.Uri[] {
    const roots = [vscode.Uri.file(__dirname)];
    if (!config.allowLocalImages) return roots;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    roots.push(workspaceFolder ? workspaceFolder.uri : vscode.Uri.file(path.dirname(filePath)));
    return roots;
}

/** Assemble the render options a webview needs (CSP, Mermaid, KaTeX). */
async function buildRenderOptions(
    panel: vscode.WebviewPanel, config: Config, nonce: string,
): Promise<Record<string, unknown>> {
    const mermaidUri = panel.webview
        .asWebviewUri(vscode.Uri.file(path.join(__dirname, 'mermaid.min.js'))).toString();

    let katexCssHtml = '';
    if (config.enableMath) {
        try {
            let katexCss = await fs.promises.readFile(path.join(__dirname, 'katex.min.css'), 'utf-8');
            const fontsBaseUri = panel.webview
                .asWebviewUri(vscode.Uri.file(path.join(__dirname, 'fonts'))).toString();
            katexCss = katexCss.replace(/url\(fonts\//g, `url(${fontsBaseUri}/`);
            katexCssHtml = `\n  <style id="katex-css">${katexCss}</style>`;
        } catch { /* KaTeX CSS not found — skip */ }
    }

    return {
        // No sourceMap: there is no editor to sync with, so line anchors serve no purpose.
        cspNonce: nonce,
        cspSource: panel.webview.cspSource,
        lang: vscode.env.language,
        allowHttpImages: config.allowHttpImages,
        mermaidScriptUri: mermaidUri,
        mermaidTheme: config.mermaidTheme,
        mermaidScale: config.mermaidScale,
        katexCssHtml,
        enableMath: config.enableMath,
    };
}

/** Banner marking the panel as a fixed snapshot, so it is never mistaken for the file. */
function revisionBanner(filePath: string, revision: Revision): string {
    const text = vscode.l10n.t(
        'Read-only snapshot of {0} at {1}. It does not follow your edits.',
        path.basename(filePath), revision.label,
    );
    return `<div style="position:sticky;top:0;z-index:10;padding:6px 12px;margin:0 0 1em;`
        + `border-bottom:1px solid rgba(127,127,127,0.4);opacity:0.85;font-size:0.85em;">`
        + `${escapeHtml(text)}</div>`;
}

/**
 * Open (or focus) a read-only preview of `filePath` at `revision`.
 *
 * @param filePath - Absolute path to the Markdown file in the working tree.
 * @param revision - Revision to render.
 * @param config - Current extension configuration.
 */
export async function openRevisionPreview(
    filePath: string, revision: Revision, config: Config,
): Promise<void> {
    if (!await findRepositoryRoot(filePath)) {
        // Distinguish "no git on this machine" from "this file is not in a repository":
        // both fail the same way, and blaming the workspace for a missing git is a dead end.
        const message = await isGitAvailable()
            ? vscode.l10n.t('{0} is not inside a Git repository.', path.basename(filePath))
            : vscode.l10n.t('Git was not found. Install Git or make sure it is on your PATH.');
        vscode.window.showErrorMessage(message);
        return;
    }

    // Read before touching the panel. A ref is not fixed over time — HEAD moves on every
    // commit and the index changes on every `git add` — so re-running the command on an
    // already-open panel must show the ref's current content, not what it held when the
    // panel was first opened.
    const content = await readFileAtRevision(filePath, revision);
    if (content === null) {
        vscode.window.showErrorMessage(vscode.l10n.t(
            '{0} does not exist at {1}.', path.basename(filePath), revision.label));
        return;
    }

    // Everything that can yield has happened by now. Looking the panel up and registering
    // it must stay a single synchronous run: introduce an `await` between the two and
    // concurrent invocations of the command would each create a panel, the later one
    // orphaning the earlier.
    const key = panelKey(filePath, revision);
    let panel = panels.get(key);
    if (panel) {
        panel.reveal(panel.viewColumn, true);
    } else {
        panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            makeTitle(filePath, revision),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: buildLocalResourceRoots(filePath, config),
                // The snapshot only re-renders when the command runs again, so keeping it
                // alive while hidden costs little and avoids a blank panel on revisit.
                retainContextWhenHidden: true,
            },
        );
        panels.set(key, panel);
        const created = panel;
        // Only clear the entry if it still points at this panel, so a disposal can never
        // evict a newer panel that has since taken the key.
        created.onDidDispose(() => {
            if (panels.get(key) === created) panels.delete(key);
        });
    }

    // Settings may have changed since the panel was created.
    panel.webview.options = {
        enableScripts: true,
        localResourceRoots: buildLocalResourceRoots(filePath, config),
    };

    try {
        const nonce = getNonce();
        const options = await buildRenderOptions(panel, config, nonce);
        const title = makeTitle(filePath, revision);
        let html = await renderHtmlAsync(content, title, config, options);
        if (config.allowLocalImages) {
            // Images are taken from the working tree, not from the revision: extracting
            // every referenced blob would mean a git call per image, and a stale-looking
            // picture beats a broken one. Diagrams — the point of this panel — are
            // rendered from the revision's own source either way.
            const webview = panel.webview;
            html = resolveLocalImagePaths(
                html,
                path.dirname(filePath),
                (absPath) => webview.asWebviewUri(vscode.Uri.file(absPath)).toString(),
            );
        }
        // Safe as a plain replace: the template's own <body> precedes any rendered
        // content, and replace() without /g substitutes only that first match.
        panel.webview.html = html.replace(/<body([^>]*)>/, `<body$1>${revisionBanner(filePath, revision)}`);
    } catch (err) {
        panel.webview.html = `<!DOCTYPE html><html><body>${errorHtml(escapeHtml((err as Error).message))}</body></html>`;
    }
}

/** Title and markup of every open revision preview. Observation point for integration
 *  tests: VS Code offers no API to read a webview panel's HTML from outside. */
export function getOpenRevisionPreviews(): { title: string; html: string }[] {
    return [...panels.values()].map(panel => ({ title: panel.title, html: panel.webview.html }));
}

/** Dispose every open revision preview. Called on extension deactivation. */
export function disposeRevisionPreviews(): void {
    for (const panel of panels.values()) panel.dispose();
    panels.clear();
}
