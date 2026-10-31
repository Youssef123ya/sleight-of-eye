// capture/vite-capture-sink.ts - dev-server-only upload endpoint for in-page recordings.
// POST /__capture/open?name=x.webm   -> creates captures/x.webm
// POST /__capture/append?name=x.webm -> appends the request body (one MediaRecorder chunk)
// POST /__capture/close?name=x.webm  -> closes the file, responds with its absolute path
import type { Plugin } from 'vite';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

export function captureSink(dir = 'captures'): Plugin {
  const files = new Map<string, WriteStream>();
  return {
    name: 'capture-sink',
    apply: 'serve',
    configureServer(server) {
      const outDir = path.resolve(server.config.root, dir);
      mkdirSync(outDir, { recursive: true });
      server.middlewares.use('/__capture', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const name = path.basename(url.searchParams.get('name') ?? 'take.webm').replace(/[^\w.-]/g, '_');
        const file = path.join(outDir, name);
        const op = url.pathname.replace(/^\//, '');
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        if (op === 'open') {
          files.get(name)?.end();
          files.set(name, createWriteStream(file));
          return res.end('ok');
        }
        if (op === 'append') {
          let out = files.get(name);
          if (!out) { out = createWriteStream(file, { flags: 'a' }); files.set(name, out); }
          req.on('data', (c) => out!.write(c));
          req.on('end', () => res.end('ok'));
          return;
        }
        if (op === 'close') {
          const out = files.get(name);
          files.delete(name);
          if (!out) return res.end(file);
          return out.end(() => res.end(file));
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}
