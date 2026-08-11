/**
 * @module git
 * @description Reading a file's content at a Git revision.
 *
 * Used by the revision preview, which renders a past version of a Markdown file
 * side by side with the working tree. Shells out to `git` rather than depending on
 * the built-in Git extension: the extension may be disabled, and its API surface is
 * far larger than the two calls needed here.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** How long a single git invocation may take before it is abandoned. */
const GIT_TIMEOUT_MS = 10000;

/** Largest blob to read from history, guarding against a huge file wedging the preview. */
const MAX_BLOB_BYTES = 20 * 1024 * 1024;

/** A revision of a tracked file. */
export interface Revision {
    /** Git ref to read, e.g. `HEAD` for the last commit or `:0` for the index. */
    ref: string;
    /** Label shown in the panel title. */
    label: string;
}

/** The last committed version. */
export const HEAD_REVISION: Revision = { ref: 'HEAD', label: 'HEAD' };

/** The staged version. */
export const STAGED_REVISION: Revision = { ref: ':0', label: 'Staged' };

/** Run a git command in `cwd` and resolve its stdout. */
function git(args: string[], cwd: string, maxBuffer = 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'utf8' },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(stderr?.trim() || err.message));
                    return;
                }
                resolve(stdout);
            });
    });
}

/**
 * Check whether the `git` executable can be run at all.
 *
 * Every other call here reports failure as "no repository", which would blame the
 * workspace for a machine without git installed. This separates the two cases so the
 * user is told something actionable.
 *
 * @returns True when git is on PATH and runnable.
 */
export async function isGitAvailable(): Promise<boolean> {
    try {
        await git(['--version'], os.tmpdir());
        return true;
    } catch {
        return false;
    }
}

/**
 * Find the repository root containing a file.
 *
 * @param filePath - Absolute path to a file.
 * @returns Absolute path to the repository root, or null when the file is not in a repository.
 */
export async function findRepositoryRoot(filePath: string): Promise<string | null> {
    try {
        const out = await git(['rev-parse', '--show-toplevel'], path.dirname(filePath));
        const root = out.trim();
        if (root.length === 0) return null;
        // Resolve here as well as on the file side. git reports a resolved path on some
        // platforms and not on others (Windows junctions), and the two must be resolved
        // the same way before one can be subtracted from the other.
        return await fs.promises.realpath(root).catch(() => root);
    } catch {
        return null;
    }
}

/**
 * Read a file's content at a given revision.
 *
 * @param filePath - Absolute path to the file in the working tree.
 * @param revision - Revision to read.
 * @returns File content at that revision, or null when the file does not exist there
 *          (added since, renamed, or never tracked).
 */
export async function readFileAtRevision(filePath: string, revision: Revision): Promise<string | null> {
    const root = await findRepositoryRoot(filePath);
    if (!root) return null;
    // `git rev-parse --show-toplevel` reports the resolved path, so the file path has to
    // be resolved too before the two can be subtracted. On macOS the difference is real
    // and routine: /var is a symlink to /private/var, and comparing the two unresolved
    // yields a relative path full of `..` that git cannot address.
    let resolvedFile = filePath;
    try {
        resolvedFile = await fs.promises.realpath(filePath);
    } catch { /* file may not exist in the working tree; fall back to the given path */ }
    // git addresses blobs by repository-relative POSIX path, regardless of platform.
    const relative = path.relative(root, resolvedFile).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    try {
        return await git(['show', `${revision.ref}:${relative}`], root, MAX_BLOB_BYTES);
    } catch {
        return null;
    }
}
