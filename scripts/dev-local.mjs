// Plain Vite dev server for local work, automated tests and footage capture:
// http://127.0.0.1:8081 with IWER injected, no CLI-managed Playwright browser.
// The env vars must be set before vite.config.ts constructs the IWSDK plugin.
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
process.env.APP_LOCAL_DEV = '1';
process.env.IWSDK_DEV_OPEN = 'false';

const { createServer } = await import('vite');
const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
server.printUrls();
