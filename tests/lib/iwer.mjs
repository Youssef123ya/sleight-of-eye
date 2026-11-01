// tests/lib/iwer.mjs — Node helpers that drive the app in headless Chrome + IWER (owned by Q).
//
// Built on playwright-core with the installed Google Chrome (channel 'chrome', no browser download), the same way
// tests/shot.mjs does. Every helper has a timeout; nothing here can hang a test run.
//
//   import * as qa from './lib/iwer.mjs';
//   const app = await qa.openApp(qa.appUrl(qa.baseUrl(args), { demo: 'debug' }), { w: 1280, h: 720 });
//   await qa.enterXR(app.page, { fov: 60 });                  // seated eye (0,1.2,0), facing -Z, hands only
//   await qa.lookAt(app.page, 'musicBox-focus');              // turn the emulated head to a named Object3D
//   await qa.pinchAt(app.page, 'right', 'coin');              // IWER run_sequence: reach, pinch on arrival, release
//   await qa.pokeAt(app.page, 'right', 'kit2-ear');           // index-tip press
//   await qa.waitForState(app.page, (s) => s.palmed === 'coin', { timeout: 5000, label: 'coin palmed' });
//   await qa.screenshot(app.page, 'tests/out/x.png');
//   qa.consoleErrors(app.page);                               // collected page errors + console.error lines
//   await app.close();
//
// Also: placeHead, wait (XR-frame time), waitFrames, setVisibility (pause/resume), runSequence (raw IWER
// run_sequence), restHand, appState / hasApp / callApp (DebugApi), findObjects (position, visual centre, box
// corners, visibility, similar names when missing), headPose, renderStats (per-view draw calls), startSampler /
// stopSampler (per-frame timings), allocationProfile (CDP sampling heap profiler by owner and app site), listDemos.
// Test pages answer Vite's HMR socket locally, so other people's edits never reload a page mid-test (openApp hmr).
//
// Coordinates are IWER's XR origin = IWSDK local-floor: metres, +Y up, -Z forward, floor at y = 0.
import { chromium } from 'playwright-core';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const OUT_DIR = path.join(APP_DIR, 'tests', 'out');
/** Seated eye used by demos and tests (layout.ts DEFAULT_EYE). */
export const DEFAULT_EYE = [0, 1.2, 0];
/** Meta VR Glasses frustum (IWER metaVRGlassesVisibilityMask): tangent-plane half angles in degrees. */
export const GLASSES = { left: 37, right: 37, up: 25, down: 43 };

export class QAError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'QAError';
    this.details = details;
  }
}

// ----------------------------------------------------------------------------------------------- utilities
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reject after `ms` with a labelled error (the original promise is left to settle on its own). */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new QAError(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** Kill the process if a script runs past `ms` (prints why). Returns a cancel function. */
export function installWatchdog(ms, label = 'test') {
  const t = setTimeout(() => {
    console.error(`[watchdog] ${label} exceeded ${Math.round(ms / 1000)} s — aborting`);
    process.exit(3);
  }, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

/** `--key=value`, `--flag` (true), `--no-flag` (false) → object. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, ...v] = a.slice(2).split('=');
    if (v.length) out[k] = v.join('=');
    else if (k.startsWith('no-')) out[k.slice(3)] = false;
    else out[k] = true;
  }
  return out;
}

/** "x,y,z" → [x,y,z] (or the fallback). */
export function vec(s, fallback) {
  if (Array.isArray(s)) return s;
  if (typeof s !== 'string') return fallback;
  const v = s.split(',').map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? v : fallback;
}

/** Dev server root: --url, else http://127.0.0.1:$APP_PORT (default 8081, like tests/shot.mjs). */
export function baseUrl(args = {}) {
  const u = args.url ?? `http://127.0.0.1:${args.port ?? process.env.APP_PORT ?? 8081}/`;
  return u;
}

/** Add/replace query parameters (`demo`, `debug`, ...) on a URL. `undefined` leaves a key alone, `null` drops it. */
export function appUrl(base, params = {}) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (v === null || v === false) u.searchParams.delete(k);
    else u.searchParams.set(k, v === true ? '1' : String(v));
  }
  return u.toString();
}

export function outPath(...parts) {
  const p = path.join(OUT_DIR, ...parts);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/** Path relative to tests/out (for links inside reports). */
export const relOut = (p) => path.relative(OUT_DIR, p).split(path.sep).join('/');

export function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return file;
}

export function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Module demos available as ?demo=<name> (src/demos/<name>.demo.ts). */
export function listDemos() {
  try {
    return readdirSync(path.join(APP_DIR, 'src', 'demos'))
      .filter((f) => f.endsWith('.demo.ts'))
      .map((f) => f.replace(/\.demo\.ts$/, ''))
      .sort();
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------------------------- browser
/** Installed Chrome, headless, GPU via ANGLE/D3D11 on Windows (as tests/shot.mjs). */
export async function launchBrowser({ headless = true, extraArgs = [] } = {}) {
  const args = [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info',
    ...extraArgs,
  ];
  if (process.platform === 'win32') args.unshift('--use-angle=d3d11');
  return withTimeout(chromium.launch({ channel: 'chrome', headless, args }), 60_000, 'Chrome launch');
}

const collectors = new WeakMap();
const BENIGN = [/X4122: sum of .* cannot be represented accurately/i];

/** Errors seen on this page so far: `[pageerror] …` and `[console] …` lines. */
export function consoleErrors(page) {
  return collectors.get(page)?.errors ?? [];
}
export function consoleWarnings(page) {
  return collectors.get(page)?.warnings ?? [];
}
export function consoleLogs(page) {
  return collectors.get(page)?.logs ?? [];
}

const RELOADABLE = /Outdated Optimize Dep|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

/**
 * Open the app in a fresh context and wait for the IWSDK world. Retries once on Vite's "Outdated Optimize Dep".
 * Returns { browser, context, page, url, errors, warnings, logs, close() }.
 */
export async function openApp(url, { w = 1280, h = 720, browser = null, timeout = 45_000, settleMs = 600, hmr = false } = {}) {
  const ownsBrowser = !browser;
  browser ??= await launchBrowser();
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  if (!hmr) {
    // Freeze the code under test: answer Vite's HMR socket (ws://host/?token=…) locally so edits made by other people
    // while a test runs never full-reload the page mid-scenario. The IWSDK bridge socket (/__iwer_mcp) is untouched.
    await context.routeWebSocket(
      (u) => u.pathname === '/' && u.searchParams.has('token'),
      (ws) => {
        ws.onMessage(() => {});
        ws.send(JSON.stringify({ type: 'connected' }));
      },
    );
  }
  const page = await context.newPage();
  const c = { errors: [], warnings: [], logs: [] };
  collectors.set(page, c);
  page.on('pageerror', (e) => c.errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') c.errors.push(`[console] ${t}`);
    else if (m.type() === 'warning') {
      if (!BENIGN.some((r) => r.test(t))) c.warnings.push(t);
    } else if (c.logs.length < 400) c.logs.push(t);
  });
  const close = async () => {
    await context.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(url, { waitUntil: 'load', timeout });
      try {
        await page.waitForFunction(() => !!window.FRAMEWORK_MCP_RUNTIME?.world, null, { timeout });
      } catch (e) {
        if (attempt === 0 && c.errors.some((x) => RELOADABLE.test(x))) {
          c.errors.length = 0;
          continue;
        }
        throw new QAError(`IWSDK world did not start at ${url} (${e.message.split('\n')[0]})`, { errors: [...c.errors] });
      }
      await sleep(settleMs);
      if (attempt === 0 && c.errors.some((x) => RELOADABLE.test(x))) {
        c.errors.length = 0;
        continue; // Vite re-optimized deps mid-load: one clean reload
      }
      break;
    }
  } catch (e) {
    await close();
    throw e;
  }
  return { browser, context, page, url, errors: c.errors, warnings: c.warnings, logs: c.logs, close };
}

// ----------------------------------------------------------------------------------------------- in-page QA lib
// Installed once per page as window.__qa: scene lookups by name, positions in the XR origin, head pose maths.
function installQaLib() {
  if (window.__qa) return true;
  const world = () => window.FRAMEWORK_MCP_RUNTIME?.world;
  const shown = (o) => {
    for (let c = o; c; c = c.parent) if (c.visible === false) return false;
    return true;
  };
  const find = (name) => {
    const w = world();
    if (!w) return null;
    let hit = null;
    let hidden = null;
    w.scene.traverse((o) => {
      if (o.name !== name || hit) return;
      if (shown(o)) hit = o;
      else hidden ??= o;
    });
    return hit ?? hidden;
  };
  // world → XR origin (world.player is rigid: inverse = R^T (p - t))
  const toOrigin = (x, y, z) => {
    const w = world();
    const m = w?.player?.matrixWorld?.elements;
    if (!m) return [x, y, z];
    const tx = x - m[12];
    const ty = y - m[13];
    const tz = z - m[14];
    return [m[0] * tx + m[1] * ty + m[2] * tz, m[4] * tx + m[5] * ty + m[6] * tz, m[8] * tx + m[9] * ty + m[10] * tz];
  };
  const posOf = (o) => {
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements;
    return toOrigin(e[12], e[13], e[14]);
  };
  // rough world-space bounding radius of the object's renderable subtree around its origin
  const radiusOf = (o) => {
    o.updateWorldMatrix(true, true);
    const oe = o.matrixWorld.elements;
    let r = 0;
    o.traverse((m) => {
      if (!(m.isMesh || m.isPoints || m.isLine) || !m.geometry || m.userData?.iwsdkRuntimeOnly) return;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const bs = m.geometry.boundingSphere;
      if (!bs) return;
      const e = m.matrixWorld.elements;
      const cx = e[0] * bs.center.x + e[4] * bs.center.y + e[8] * bs.center.z + e[12];
      const cy = e[1] * bs.center.x + e[5] * bs.center.y + e[9] * bs.center.z + e[13];
      const cz = e[2] * bs.center.x + e[6] * bs.center.y + e[10] * bs.center.z + e[14];
      const s = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
      r = Math.max(r, Math.hypot(cx - oe[12], cy - oe[13], cz - oe[14]) + bs.radius * s);
    });
    return r;
  };
  // 8 corners (XR origin) of the world-space box around the object's renderable subtree; null without geometry
  // world box (min/max) of the VISIBLE renderable subtree; null for empty anchors
  const boxOf = (o) => {
    o.updateWorldMatrix(true, true);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const stack = [o];
    while (stack.length) {
      const m = stack.pop();
      if (m !== o && m.visible === false) continue;
      for (const c of m.children) stack.push(c);
      if (!(m.isMesh || m.isPoints || m.isLine) || !m.geometry || m.userData?.iwsdkRuntimeOnly) continue;
      if (m.isSprite) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      if (!b) return;
      const e = m.matrixWorld.elements;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? b.max.x : b.min.x;
        const y = i & 2 ? b.max.y : b.min.y;
        const z = i & 4 ? b.max.z : b.min.z;
        const w = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], w[k]);
          max[k] = Math.max(max[k], w[k]);
        }
      }
    }
    return Number.isFinite(min[0]) ? { min, max } : null;
  };
  // 8 corners (XR origin) of that box
  const cornersOf = (o) => {
    const b = boxOf(o);
    if (!b) return null;
    const out = [];
    for (let i = 0; i < 8; i++) out.push(toOrigin(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]));
    return out;
  };
  // where a person would look: the centre of the visible geometry (meshes baked in parent space have their origin
  // elsewhere, e.g. the game's 'mat'), or the origin for empty anchors ('-focus', '-head', 'volunteerSpot')
  const centerOf = (o) => {
    const b = boxOf(o);
    if (!b) return posOf(o);
    return toOrigin((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  };
  const head = () => {
    const d = window.IWER_DEVICE;
    if (!d) return null;
    const q = [d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w];
    return { position: [d.position.x, d.position.y, d.position.z], quaternion: q, forward: forwardOf(q) };
  };
  const forwardOf = (q) => {
    const [x, y, z, w] = q;
    return [-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y))];
  };
  const names = () => {
    const w = world();
    const out = new Set();
    w?.scene.traverse((o) => {
      if (o.name) out.add(o.name);
    });
    return [...out];
  };
  const similar = (name, max = 8) => {
    const lc = name.toLowerCase();
    const dist = (a, b) => {
      const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
      for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= b.length; j++) {
          const t = dp[j];
          dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
          prev = t;
        }
      }
      return dp[b.length];
    };
    return names()
      .map((n) => ({ n, d: n.toLowerCase().includes(lc) || lc.includes(n.toLowerCase()) ? 0 : dist(lc, n.toLowerCase()) }))
      .filter((x) => x.d <= Math.max(3, lc.length / 2))
      .sort((a, b) => a.d - b.d)
      .slice(0, max)
      .map((x) => x.n);
  };
  const describe = (name, withCorners = false) => {
    const o = find(name);
    if (!o) return { name, found: false, similar: similar(name) };
    return { name, found: true, visible: shown(o), position: posOf(o), center: centerOf(o), radius: radiusOf(o), type: o.type, corners: withCorners ? cornersOf(o) : undefined };
  };
  /** JSON-safe copy of a debug state (Object3D → name, vectors → arrays, cycles cut). */
  const safe = (v) => {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(v, (_k, x) => {
        if (x && typeof x === 'object') {
          if (x.isObject3D) return `[Object3D ${x.name || x.type}]`;
          if (x.isVector3) return [x.x, x.y, x.z];
          if (seen.has(x)) return '[cycle]';
          seen.add(x);
        }
        if (typeof x === 'number' && !Number.isFinite(x)) return String(x);
        return x;
      }) ?? 'null',
    );
  };
  const xrFrames = (n) =>
    new Promise((resolve) => {
      const s = window.IWER_DEVICE?.activeSession;
      if (!s) return setTimeout(resolve, n * 17);
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : s.requestAnimationFrame(tick));
      s.requestAnimationFrame(tick);
    });
  window.__qa = { world, find, shown, posOf, radiusOf, boxOf, cornersOf, centerOf, head, forwardOf, names, similar, describe, safe, xrFrames, toOrigin };
  return true;
}

async function qa(page, fn, arg, { timeout = 15_000, label = 'page call' } = {}) {
  await withTimeout(page.evaluate(installQaLib), 10_000, 'install QA lib');
  return withTimeout(page.evaluate(fn, arg), timeout, label);
}

/** Positions (XR origin), radius and visibility of named Object3Ds; missing ones come back with `similar` names. */
export async function findObjects(page, names, { corners = false } = {}) {
  return qa(page, ({ ns, corners }) => ns.map((n) => window.__qa.describe(n, corners)), { ns: names, corners }, { label: 'findObjects' });
}

/** Every Object3D name in the scene (diagnostics). */
export async function sceneNames(page) {
  return qa(page, () => window.__qa.names(), undefined, { label: 'sceneNames' });
}

/** Current emulated head pose: { position, quaternion, forward }. */
export async function headPose(page) {
  return qa(page, () => window.__qa.head(), undefined, { label: 'headPose' });
}

/** Wait `n` XR frames (or ~n×17 ms outside XR). */
export async function waitFrames(page, n = 2) {
  return qa(page, (k) => window.__qa.xrFrames(k), n, { timeout: 10_000 + n * 50, label: `wait ${n} frames` });
}

// ----------------------------------------------------------------------------------------------- XR session
/**
 * Enter the emulated XR session, hands only, with the head ALREADY at `head` looking at `look` when the first XR
 * frame arrives (so a game that calibrates its stage from the first head pose sees the seated eye). Attaches the
 * DemoDirector from /capture/director.js as window.__director and hides the IWER DevUI.
 * `enter`: 'auto' clicks a visible landing "Enter" button if the page has one, else accepts IWER's offered session.
 * A visible button that is still disabled (the game's #enter-btn waits for isSessionSupported) is given up to
 * `enterWaitMs` to enable, so the session starts from a real click (user activation: XR + audio unlock) like a player's.
 */
export async function enterXR(
  page,
  { fov = 60, head = DEFAULT_EYE, look, inputMode = 'hand', enter = 'auto', enterSelector, enterWaitMs = 15_000, timeout = 40_000 } = {},
) {
  const lookAtPt = look ?? [head[0], head[1], head[2] - 1];
  await withTimeout(page.evaluate(installQaLib), 10_000, 'install QA lib');
  // 1) pre-place the device before any session exists
  await qa(
    page,
    async ({ fov, head, look, inputMode, timeout }) => {
      const t0 = performance.now();
      while (!window.IWER_DEVICE) {
        if (performance.now() - t0 > timeout) throw new Error('window.IWER_DEVICE missing: IWER is injected only on localhost/127.0.0.1 dev servers');
        await new Promise((r) => setTimeout(r, 50));
      }
      const dev = window.IWER_DEVICE;
      dev.remote.RELEASE_TIMEOUT_MS = 24 * 3600 * 1000; // never hand control back to DevUI mid-test
      if (dev.activeSession) return { already: true };
      const { lookRotation } = await import('/capture/director.js');
      dev.controlMode = 'programmatic'; // DevUI stops rewriting the head pose
      if (inputMode) dev.primaryInputMode = inputMode;
      dev.fovy = (fov * Math.PI) / 180;
      dev.position.set(head[0], head[1], head[2]);
      const q = lookRotation(head, look);
      dev.quaternion.set(q[0], q[1], q[2], q[3]);
      dev.notifyStateChange?.();
      return { already: false };
    },
    { fov, head, look: lookAtPt, inputMode, timeout },
    { timeout: timeout + 5000, label: 'pre-place headset' },
  );
  // 2) start the session: landing button (a real click = user activation) or IWER's offered session
  let via = 'offer';
  if (enter !== 'offer') {
    // XPath never pierces shadow roots, so IWER's own 'Enter XR' pill (shadow DOM) is not mistaken for the app's.
    const selectors = enterSelector
      ? [enterSelector]
      : [
          'xpath=//*[@data-enter]',
          'xpath=//*[@id="enter" or @id="enter-btn" or @id="enter-button" or @id="enterButton"]',
          'xpath=//button[contains(translate(normalize-space(.), "ENTR", "entr"), "enter")]',
        ];
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      const t0 = Date.now();
      let enabled = await btn.isEnabled().catch(() => false);
      while (!enabled && Date.now() - t0 < enterWaitMs) {
        await sleep(100);
        enabled = await btn.isEnabled().catch(() => false);
      }
      if (!enabled) continue; // e.g. "VR headset needed": accept IWER's offered session instead
      await btn.click({ timeout: 5000 }).catch(() => {});
      via = `button ${sel}`;
      break;
    }
  }
  const info = await qa(
    page,
    async ({ fov, head, look, inputMode, timeout, via }) => {
      const dev = window.IWER_DEVICE;
      const t0 = performance.now();
      const until = async (fn, what, ms) => {
        while (!fn()) {
          if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      if (via !== 'offer') await until(() => dev.activeSession, 'XR session after the Enter click', 8000).catch(() => {});
      if (!dev.activeSession) {
        await until(() => dev.sessionOffered || dev.activeSession, 'an offered XR session (iwsdk.config xr.offer)', timeout);
        if (!dev.activeSession) await dev.remote.dispatch('accept_session');
        await until(() => dev.activeSession, 'XR session start', timeout);
      }
      const { DemoDirector } = await import('/capture/director.js');
      const d = await DemoDirector.attach({ fovyDeg: fov, inputMode });
      window.__director = d;
      d.place({ head, look });
      await d.wait(0.5);
      const s = dev.activeSession;
      const w = window.FRAMEWORK_MCP_RUNTIME?.world;
      return {
        xrActive: !!s,
        via,
        iwer: dev.version,
        device: dev.name,
        inputSources: [...s.inputSources].map((x) => ({ handedness: x.handedness, hand: !!x.hand, mode: x.targetRayMode })),
        views: w?.renderer?.xr?.getCamera?.().cameras?.length ?? 0,
        multiview: !!w?.renderer?.xr?.isMultiview,
        canvas: [dev.appCanvas?.width, dev.appCanvas?.height],
        head: window.__qa.head(),
      };
    },
    { fov, head, look: lookAtPt, inputMode, timeout, via },
    { timeout: timeout * 2 + 10_000, label: 'enterXR' },
  );
  return info;
}

/** Teleport the emulated headset (no animation) and wait for the pose to reach the app (2 XR frames). */
export async function placeHead(page, head, look, { roll = 0, frames = 2 } = {}) {
  return qa(
    page,
    async ({ head, look, roll, frames }) => {
      const d = window.__director;
      if (!d) throw new Error('placeHead: call enterXR first (no window.__director)');
      const cur = window.__qa.head();
      const h = head ?? cur.position;
      const l = look ?? [h[0] + cur.forward[0], h[1] + cur.forward[1], h[2] + cur.forward[2]];
      d.place({ head: h, look: l, roll });
      await window.__qa.xrFrames(frames);
      return window.__qa.head();
    },
    { head, look, roll, frames },
    { label: 'placeHead' },
  );
}

/**
 * Turn the emulated head to a named Object3D (or an [x,y,z] XR-origin point), keeping the head position.
 * `duration` > 0 animates the turn (min-jerk, like a person's glance). Returns the target and its angles.
 */
export async function lookAt(page, target, { head = null, duration = 0, frames = 2 } = {}) {
  return qa(
    page,
    async ({ target, head, duration, frames }) => {
      const d = window.__director;
      if (!d) throw new Error('lookAt: call enterXR first (no window.__director)');
      let p = target;
      if (typeof target === 'string') {
        const o = window.__qa.find(target);
        if (!o) {
          const near = window.__qa.similar(target);
          throw new Error(`lookAt: no Object3D named "${target}"${near.length ? ` (similar: ${near.join(', ')})` : ''}`);
        }
        p = window.__qa.centerOf(o);
      }
      const cur = window.__qa.head();
      const h = head ?? cur.position;
      if (duration > 0) {
        const from = [h[0] + cur.forward[0], h[1] + cur.forward[1], h[2] + cur.forward[2]];
        await d.play({ duration, head: { pos: [h, h], look: { points: [from, p], ease: 'minJerk' } } });
      } else d.place({ head: h, look: p });
      await window.__qa.xrFrames(frames);
      const dx = p[0] - h[0];
      const dy = p[1] - h[1];
      const dz = p[2] - h[2];
      return {
        target,
        position: p,
        yaw: (Math.atan2(dx, -dz) * 180) / Math.PI,
        pitch: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
        distance: Math.hypot(dx, dy, dz),
      };
    },
    { target, head, duration, frames },
    { timeout: 15_000 + duration * 1000, label: `lookAt ${JSON.stringify(target)}` },
  );
}

/** Hold still for `seconds` of XR-frame time (falls back to wall time outside XR). */
export async function wait(page, seconds) {
  return qa(
    page,
    async (s) => {
      if (window.__director && window.IWER_DEVICE?.activeSession) await window.__director.wait(s);
      else await new Promise((r) => setTimeout(r, s * 1000));
      return true;
    },
    seconds,
    { timeout: seconds * 1000 + 15_000, label: `wait ${seconds}s` },
  );
}

/** Simulate the session being hidden / blurred / visible again (pause and resume). */
export async function setVisibility(page, state) {
  return qa(page, (s) => (window.IWER_DEVICE.updateVisibilityState(s), s), state, { label: `visibility ${state}` });
}

// ----------------------------------------------------------------------------------------------- hands
/**
 * IWER_DEVICE.remote.runSequence(params). Resolves to the IWER result ({ completed, events, presses, warnings,
 * steps, final, ... }); errors (bad target, reach) resolve as { completed: false, error } instead of throwing.
 */
export async function runSequence(page, params, { timeout = 30_000 } = {}) {
  try {
    return await qa(
      page,
      async (p) => {
        try {
          return await window.IWER_DEVICE.remote.runSequence(p);
        } catch (e) {
          return { completed: false, error: String(e?.message ?? e) };
        }
      },
      params,
      { timeout, label: `run_sequence ${params?.device}` },
    );
  } catch (e) {
    await qa(page, () => window.IWER_DEVICE.remote.dispatch('cancel_sequence').catch(() => null), undefined, {
      timeout: 5000,
      label: 'cancel_sequence',
    }).catch(() => {});
    return { completed: false, error: String(e?.message ?? e) };
  }
}

const deviceOf = (side) => (side === 'left' ? 'hand-left' : 'hand-right');
// idleHand left undefined = IWER's default: the other hand rests by the hip unless it is pinching.
const seqParams = (side, steps, { gaze, body, idleHand }) => ({
  device: deviceOf(side),
  steps,
  ...(gaze ? { gaze } : {}),
  ...(body ? { body } : {}),
  ...(idleHand ? { idleHand } : {}),
});
const countEvents = (result, type) => (result?.events ?? []).filter((e) => e.type === type).length;

/**
 * Reach `side`'s hand to a named target and pinch on arrival (thumb+index meet there: the 8 cm magnet sees it).
 * Options: hold (s), release (true), lift (m, raise the pinched hand before release), approach (m), gaze
 * ('fixed' keeps the head where you put it — a look-away steal needs that), body ('fixed' = seated), idleHand.
 * Returns { ok, selects, result }: ok = sequence completed and the app saw a selectstart.
 */
export async function pinchAt(
  page,
  side,
  target,
  { hold = 0.25, release = true, lift = 0, approach = 0.05, gaze = 'fixed', body = 'fixed', idleHand, retreat = 0, timeout = 30_000 } = {},
) {
  const steps = [{ label: `reach ${target}`, target, approach: { distance: approach }, pinch: { value: 1, at: 'arrival' } }];
  if (lift) steps.push({ label: 'lift', offset: { x: 0, y: lift, z: 0 } });
  if (hold > 0) steps.push({ label: 'hold', duration: hold });
  if (release) steps.push({ label: 'release', pinch: 0, duration: 0.12 });
  if (retreat) steps.push({ label: 'retreat', offset: { x: 0, y: retreat, z: retreat } });
  const result = await runSequence(page, seqParams(side, steps, { gaze, body, idleHand }), { timeout });
  const selects = countEvents(result, 'selectstart');
  return { ok: !!result?.completed && selects > 0, selects, result };
}

/**
 * Poke a named target with `side`'s index fingertip (IWER press: reach, push `depth` past the surface, retract).
 * Returns { ok, contactMs, result }.
 */
export async function pokeAt(
  page,
  side,
  target,
  { depth = 0.012, hold = 0.06, gaze = 'fixed', body = 'fixed', idleHand, timeout = 30_000 } = {},
) {
  const steps = [{ label: `poke ${target}`, target, press: { depth, hold } }];
  const result = await runSequence(page, seqParams(side, steps, { gaze, body, idleHand }), { timeout });
  const contactMs = result?.presses?.[0]?.contactMs ?? null;
  return { ok: !!result?.completed, contactMs, result };
}

/** Move a hand out of the way (hanging by the hip) without pinching. */
export async function restHand(page, side, { timeout = 15_000 } = {}) {
  return runSequence(
    page,
    {
      device: deviceOf(side),
      steps: [{ label: 'rest', position: { relativeTo: 'body', x: side === 'left' ? -0.25 : 0.25, y: 0.75, z: 0.05 }, anchor: 'wrist', pinch: 0 }],
      gaze: 'fixed',
      body: 'fixed',
      idleHand: 'keep',
    },
    { timeout },
  );
}

// ----------------------------------------------------------------------------------------------- app state
/** window.__app?.debugState() as JSON (null when there is no game API). */
export async function appState(page) {
  return qa(
    page,
    () => {
      try {
        const s = window.__app?.debugState?.();
        return s === undefined ? null : window.__qa.safe(s);
      } catch (e) {
        return { __error: String(e?.message ?? e) };
      }
    },
    undefined,
    { timeout: 5000, label: 'debugState' },
  );
}

/** True when the page exposes the game's DebugApi (window.__app). */
export async function hasApp(page, { timeout = 0 } = {}) {
  const t0 = Date.now();
  do {
    const ok = await qa(page, () => typeof window.__app?.debugState === 'function', undefined, { timeout: 5000 }).catch(() => false);
    if (ok) return true;
    if (timeout) await sleep(250);
  } while (Date.now() - t0 < timeout);
  return false;
}

/** Call a DebugApi method (skipTo, setSettings, fovReport) by name. */
export async function callApp(page, method, ...args) {
  return qa(
    page,
    ({ method, args }) => {
      const app = window.__app;
      if (!app || typeof app[method] !== 'function') throw new Error(`window.__app.${method} is not available`);
      return window.__qa.safe(app[method](...args) ?? null);
    },
    { method, args },
    { label: `__app.${method}` },
  );
}

/**
 * Poll window.__app.debugState() until `predicate(state)` (a Node function) is true. Resolves with the state;
 * throws QAError(details.state = last state) after `timeout` ms. Use `throws: false` to get null instead.
 */
export async function waitForState(page, predicate, { timeout = 10_000, interval = 100, label, throws = true } = {}) {
  const t0 = Date.now();
  let last = null;
  let lastErr = null;
  while (true) {
    try {
      last = await appState(page);
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (last && !last.__error) {
      try {
        if (predicate(last)) return last;
      } catch {
        /* predicate errors count as "not yet" */
      }
    }
    if (Date.now() - t0 >= timeout) break;
    await sleep(interval);
  }
  if (!throws) return null;
  const what = label ?? predicate.toString().replace(/\s+/g, ' ').slice(0, 120);
  throw new QAError(`waitForState timed out after ${timeout} ms waiting for: ${what}`, {
    state: last,
    error: lastErr ? String(lastErr.message ?? lastErr) : last?.__error,
  });
}

// ----------------------------------------------------------------------------------------------- output
/** Screenshot to `file` (relative paths resolve from the app dir). Returns the absolute path. */
export async function screenshot(page, file, { clip } = {}) {
  const p = path.isAbsolute(file) ? file : path.join(APP_DIR, file);
  mkdirSync(path.dirname(p), { recursive: true });
  await withTimeout(page.screenshot({ path: p, clip, timeout: 20_000 }), 25_000, `screenshot ${path.basename(p)}`);
  return p;
}

/**
 * Renderer numbers right now plus measured fps over `ms`. Draw calls and triangles are also given per view:
 * IWER renders each object once per eye view (no multiview), the Quest once (OCULUS_multiview).
 */
export async function renderStats(page, ms = 1000) {
  return qa(
    page,
    async (ms) => {
      const w = window.__qa.world();
      const info = w?.renderer?.info;
      const t0 = performance.now();
      let frames = 0;
      const s = window.IWER_DEVICE?.activeSession;
      await new Promise((resolve) => {
        const tick = () => {
          frames++;
          if (performance.now() - t0 >= ms) resolve();
          else if (s) s.requestAnimationFrame(tick);
          else requestAnimationFrame(tick);
        };
        if (s) s.requestAnimationFrame(tick);
        else requestAnimationFrame(tick);
      });
      const xr = w?.renderer?.xr;
      const views = xr?.isPresenting && !xr.isMultiview ? Math.max(1, xr.getCamera().cameras.length) : 1;
      return {
        fps: Math.round((frames * 1000) / (performance.now() - t0)),
        drawCalls: info?.render?.calls ?? null,
        triangles: info?.render?.triangles ?? null,
        views,
        drawCallsPerView: info ? Math.round(info.render.calls / views) : null,
        trianglesPerView: info ? Math.round(info.render.triangles / views) : null,
        programs: info?.programs?.length ?? null,
        geometries: info?.memory?.geometries ?? null,
        textures: info?.memory?.textures ?? null,
        xrActive: !!s,
      };
    },
    ms,
    { timeout: ms + 15_000, label: 'renderStats' },
  );
}

/**
 * Per-frame sampler (in page): frame interval, renderer.info (per view), CPU ms in world.update (systems) and
 * renderer.render (draw submission), JS heap growth. Call startSampler, act, then stopSampler for the aggregate.
 */
export async function startSampler(page, { capacity = 4096 } = {}) {
  return qa(
    page,
    (capacity) => {
      const w = window.__qa.world();
      if (!w) throw new Error('no world');
      window.__qaSampler?.stop?.();
      const S = {
        n: 0,
        dt: new Float32Array(capacity),
        calls: new Float32Array(capacity),
        tris: new Float32Array(capacity),
        upd: new Float32Array(capacity),
        rnd: new Float32Array(capacity),
        heap: new Float64Array(capacity),
        views: 1,
        last: -1,
        updMs: 0,
        rndMs: 0,
        t0: performance.now(),
      };
      const origUpdate = w.update;
      const origRender = w.renderer.render;
      w.update = function (...a) {
        const t = performance.now();
        try {
          return origUpdate.apply(this, a);
        } finally {
          S.updMs = performance.now() - t;
        }
      };
      w.renderer.render = function (...a) {
        const t = performance.now();
        try {
          return origRender.apply(this, a);
        } finally {
          S.rndMs = performance.now() - t;
        }
      };
      const stopFrame = w.onXRFrame(() => {
        const now = performance.now();
        if (S.last >= 0 && S.n < capacity) {
          const i = S.n++;
          const info = w.renderer.info; // previous frame (render resets at its start)
          const xr = w.renderer.xr;
          S.views = xr.isPresenting && !xr.isMultiview ? Math.max(1, xr.getCamera().cameras.length) : 1;
          S.dt[i] = now - S.last;
          S.calls[i] = info.render.calls / S.views;
          S.tris[i] = info.render.triangles / S.views;
          S.upd[i] = S.updMs;
          S.rnd[i] = S.rndMs;
          S.heap[i] = performance.memory?.usedJSHeapSize ?? 0;
        }
        S.last = now;
      });
      S.stop = () => {
        stopFrame();
        w.update = origUpdate;
        w.renderer.render = origRender;
        delete w.update; // drop the own property if the original lived on the prototype
        if (w.update !== origUpdate) w.update = origUpdate;
        delete w.renderer.render;
        if (w.renderer.render !== origRender) w.renderer.render = origRender;
      };
      window.__qaSampler = S;
      return true;
    },
    capacity,
    { label: 'startSampler' },
  );
}

export async function stopSampler(page) {
  return qa(
    page,
    () => {
      const S = window.__qaSampler;
      if (!S) throw new Error('sampler not started');
      S.stop();
      window.__qaSampler = null;
      const w = window.__qa.world();
      const n = S.n;
      const agg = (arr) => {
        if (!n) return { avg: 0, p95: 0, max: 0 };
        const a = Array.from(arr.subarray(0, n)).sort((x, y) => x - y);
        const sum = a.reduce((s, v) => s + v, 0);
        return { avg: sum / n, p95: a[Math.min(n - 1, Math.ceil(n * 0.95) - 1)], max: a[n - 1] };
      };
      // heap growth between GCs = allocation rate
      let grow = 0;
      let gcs = 0;
      for (let i = 1; i < n; i++) {
        const d = S.heap[i] - S.heap[i - 1];
        if (d > 0) grow += d;
        else if (d < 0) gcs++;
      }
      const seconds = (performance.now() - S.t0) / 1000;
      const dt = agg(S.dt);
      const info = w.renderer.info;
      return {
        frames: n,
        seconds,
        fps: dt.avg ? 1000 / dt.avg : 0,
        frameMs: dt,
        hitches: Array.from(S.dt.subarray(0, n)).filter((v) => v > dt.avg * 1.8).length,
        drawCallsPerView: agg(S.calls),
        trianglesPerView: agg(S.tris),
        systemsMs: agg(S.upd),
        renderMs: agg(S.rnd),
        views: S.views,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        heapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1048576,
        allocKBPerFrame: n > 1 ? grow / 1024 / (n - 1) : 0,
        gcCount: gcs,
        overlay: window.__debugOverlay?.snapshot?.() ?? null,
      };
    },
    undefined,
    { label: 'stopSampler' },
  );
}

const IWER_OWNER = 'IWER emulator (dev only)';
const DEPS_OWNER = 'dependencies (three / IWSDK, pre-bundled)';
function scriptOwner(url) {
  if (!url) return null;
  let p = url;
  try {
    p = decodeURIComponent(new URL(url).pathname);
  } catch {
    /* keep */
  }
  if (/iwer|injection-runtime|iwsdk-dev-runtime/i.test(p)) return IWER_OWNER; // the injected emulator bundle
  if (p.includes('/capture/')) return `capture/${p.slice(p.indexOf('/capture/') + 9)}`;
  if (p.includes('/node_modules/')) return DEPS_OWNER;
  if (p.includes('/src/')) return p.slice(p.indexOf('/src/') + 1);
  if (p.startsWith('/@')) return `vite ${p.slice(0, 48)}`;
  return p;
}

/**
 * Allocation profile while `during()` runs: Chrome's sampling heap profiler (CDP), garbage included, so it measures
 * allocation VOLUME. Each sample is charged to the deepest app frame (src/...) on its stack — app code calling into
 * three is still the app's allocation — except allocations made inside the IWER emulator (e.g. emulated
 * XRFrame.fillPoses), which do not exist on a real headset and are charged to IWER.
 * Returns { totalKB, owners: [{ owner, kb, share }], sites: [{ site, kb }] } (app sites = file:line function).
 */
export async function allocationProfile(page, during, { samplingInterval = 4096 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await during();
    const { profile } = await withTimeout(cdp.send('HeapProfiler.stopSampling'), 30_000, 'stop heap sampling');
    const owners = new Map();
    const sites = new Map();
    const depSites = new Map();
    const fileOf = (url) => {
      try {
        return new URL(url).pathname.split('/').pop().replace(/\?.*$/, '');
      } catch {
        return url;
      }
    };
    const walk = (node, owner, site, depSite) => {
      const cf = node.callFrame ?? {};
      const o = scriptOwner(cf.url);
      if (o && o.startsWith('src/')) {
        owner = o;
        site = `${o}:${(cf.lineNumber ?? 0) + 1} ${cf.functionName || '(anonymous)'}`;
      } else if (o === IWER_OWNER) {
        owner = IWER_OWNER; // deeper than any app frame: emulator-only work
        site = null;
      } else if (o && !owner) owner = o; // a dependency's own work (not under app code)
      else if (o && owner === IWER_OWNER && o !== IWER_OWNER) owner = o; // the frame loop calling into three/IWSDK
      if (o === DEPS_OWNER) depSite = `${fileOf(cf.url)}:${(cf.lineNumber ?? 0) + 1} ${cf.functionName || '(anonymous)'}`;
      if (node.selfSize) {
        const key = owner ?? '(native / unknown)';
        owners.set(key, (owners.get(key) ?? 0) + node.selfSize);
        if (site && key.startsWith('src/')) sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
        if (key === DEPS_OWNER && depSite) depSites.set(depSite, (depSites.get(depSite) ?? 0) + node.selfSize);
      }
      for (const c of node.children ?? []) walk(c, owner, site, depSite);
    };
    walk(profile.head, null, null, null);
    const total = [...owners.values()].reduce((a, b) => a + b, 0) || 1;
    const list = (m, key) => [...m.entries()].map(([k, bytes]) => ({ [key]: k, kb: bytes / 1024 })).sort((a, b) => b.kb - a.kb);
    return {
      totalKB: total / 1024,
      owners: [...owners.entries()]
        .map(([owner, bytes]) => ({ owner, kb: bytes / 1024, share: bytes / total }))
        .sort((a, b) => b.kb - a.kb),
      sites: list(sites, 'site'),
      depSites: list(depSites, 'site'),
    };
  } finally {
    await cdp.send('HeapProfiler.disable').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

// ----------------------------------------------------------------------------------------------- reporting
/** Markdown table from rows (arrays of cells). */
export function mdTable(header, rows) {
  const esc = (c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${header.map(esc).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

export const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v ?? '–'));
