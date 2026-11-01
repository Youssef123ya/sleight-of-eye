// tests/shot.mjs — headless screenshot + health check of the running dev server.
// Uses the installed Google Chrome (playwright-core channel 'chrome'): no browser download.
//
//   node tests/shot.mjs [--url=http://127.0.0.1:8081/] [--out=tests/out/shot.png] [--w=1280] [--h=720]
//                       [--xr] [--head=x,y,z] [--look=x,y,z] [--fov=60] [--wait=1500] [--hmr]
//                       [--scenario=tests/scenarios/foo.mjs]
//
// --xr       pre-place the emulated head, enter XR (the landing's Enter button when present, else IWER's offered
//            session), switch IWER to hands only and hide the DevUI overlay (tests/lib/iwer.mjs enterXR).
// --head/--look  emulated headset pose (metres, local-floor: y up, -Z forward); default eye 0,1.2,0.
// --hmr      let Vite hot-reload the page (off by default so other people's edits never reload a capture).
// --scenario a module whose default export `async (page, api) => result` runs after setup;
//            `api` = { evaluate, shot(name), wait(ms), director(fn) } — see bottom of file.
// Prints one JSON object: { out, errors, warnings, stats, scenario }. Exit code 1 on page errors.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { enterXR, openApp } from './lib/iwer.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
const url = args.url ?? `http://127.0.0.1:${process.env.APP_PORT ?? 8081}/`;
const out = path.resolve(args.out ?? 'tests/out/shot.png');
const vec = (s) => (typeof s === 'string' ? s.split(',').map(Number) : undefined);
mkdirSync(path.dirname(out), { recursive: true });

let app;
let exitCode = 0;
try {
  app = await openApp(url, { w: Number(args.w ?? 1280), h: Number(args.h ?? 720), hmr: !!args.hmr });
  const { page } = app;

  if (args.xr) {
    const head = vec(args.head) ?? [0, 1.2, 0];
    await enterXR(page, { fov: Number(args.fov ?? 60), head, look: vec(args.look) ?? [head[0], head[1] - 0.3, head[2] - 1] });
  }

  let scenario;
  if (args.scenario) {
    const mod = await import(pathToFileURL(path.resolve(args.scenario)).href);
    const api = {
      evaluate: (fn, arg) => page.evaluate(fn, arg),
      wait: (ms) => page.waitForTimeout(ms),
      shot: (name) => page.screenshot({ path: path.join(path.dirname(out), `${name}.png`) }),
      // run a function in the page with the DemoDirector instance (requires --xr)
      director: (fn, arg) => page.evaluate(([src, a]) => new Function('d', 'arg', `return (${src})(d, arg)`)(window.__director, a), [fn.toString(), arg]),
    };
    scenario = await mod.default(page, api);
  }

  await page.waitForTimeout(Number(args.wait ?? 1500));
  const stats = await page.evaluate(async () => {
    const world = window.FRAMEWORK_MCP_RUNTIME?.world;
    const info = world?.renderer?.info;
    const t0 = performance.now();
    let frames = 0;
    await new Promise((resolve) => {
      const tick = () => (++frames, performance.now() - t0 < 1000 ? requestAnimationFrame(tick) : resolve());
      requestAnimationFrame(tick);
    });
    return {
      fps: Math.round((frames * 1000) / (performance.now() - t0)),
      drawCalls: info?.render?.calls, // IWER renders 2 views without multiview: per-view cost is about half
      triangles: info?.render?.triangles,
      programs: info?.programs?.length,
      geometries: info?.memory?.geometries,
      textures: info?.memory?.textures,
      xrActive: !!window.IWER_DEVICE?.activeSession,
      appState: window.__app?.debugState?.() ?? null,
    };
  });
  await page.screenshot({ path: out });
  if (app.errors.length) exitCode = 1;
  console.log(JSON.stringify({ out, errors: app.errors, warnings: app.warnings.slice(0, 20), stats, scenario }, null, 2));
} catch (e) {
  exitCode = 2;
  console.log(JSON.stringify({ out, fatal: String(e?.stack ?? e), errors: app?.errors ?? [], warnings: (app?.warnings ?? []).slice(0, 20) }, null, 2));
} finally {
  await app?.close?.();
  process.exit(exitCode);
}
