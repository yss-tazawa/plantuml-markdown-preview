/**
 * @module d2-worker
 * @description Entry point of the D2 Wasm worker thread.
 *
 * The build copies this file to dist/d2/worker.js, the script the D2 package
 * starts as its worker, and the package's own worker script to
 * dist/d2/d2-worker.js. Go's wasm_exec.js, which the worker runs first, requires
 * globalThis.crypto. Node defines it only from version 19, while the extension
 * host of older VS Code (1.83, Electron 25) runs Node 18, so it is filled in
 * from node:crypto before the D2 worker loads.
 */
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

await import('./d2-worker.js');
