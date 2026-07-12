import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests live under private/tests. Extension modules import the `vscode`
// module, which only exists inside the extension host — alias it to a stub.
export default defineConfig({
    resolve: {
        alias: {
            vscode: fileURLToPath(new URL('./private/tests/vscode-stub.ts', import.meta.url)),
        },
    },
    test: {
        include: ['private/tests/**/*.test.ts'],
        environment: 'node',
        // Tests live under the gitignored private/ dir; a clean checkout has none.
        passWithNoTests: true,
    },
});
