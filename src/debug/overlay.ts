// QA debug overlay (owned by Q). `?debug=1` shows a small world-locked stats panel that lazily follows the head:
// smoothed FPS, frame ms (avg / p95 / max over 2 s) with a frame-time graph, draw calls, triangles, programs,
// geometries, textures, plus `window.__app.debugState()` summary lines when the game exposes them.
// Placement: low in view by default; `&debugPos=left|right|top` (or `&debugYaw=<deg>&debugPitch=<deg>`) moves it
// off the mat for playtests.
//
// Cost: ONE mesh with one CanvasTexture (1 draw call per view). The canvas is redrawn at `refreshHz` (4 Hz);
// per-frame work is a few renderer.info reads, one ring-buffer write and the follow maths (no allocation).
//
// renderer.info is reset by three at the START of every renderer.render() (autoReset), and IWSDK renders exactly
// once per frame after the systems run. Reading it from the update loop therefore sees the complete previous frame.
// In XR without multiview (IWER on desktop) three draws every object once per view, so raw counts are 2x what the
// Quest (OCULUS_multiview, one pass) issues: the panel shows the per-view figure, which is what the budget means.
import {
  CanvasTexture,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type Entity,
  type World,
} from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import { onUpdate } from '../boot/loop.js';

export interface DebugOverlayOptions {
  /** Show even without `?debug=1` (demos, tests). */
  force?: boolean;
  /** Metres from the eyes. */
  distance?: number;
  /** Degrees below (negative) the view centre. */
  pitchDeg?: number;
  /** Degrees to the right (positive) of the view centre. */
  yawDeg?: number;
  /** Canvas redraws per second. */
  refreshHz?: number;
}

export interface DebugOverlaySnapshot {
  fps: number;
  frameMsAvg: number;
  frameMsP95: number;
  frameMsMax: number;
  /** Frames inside the 2 s window. */
  windowFrames: number;
  /** Frames seen since install. */
  frames: number;
  drawCalls: number;
  drawCallsPerView: number;
  triangles: number;
  trianglesPerView: number;
  programs: number;
  geometries: number;
  textures: number;
  /** Views three renders separately (2 in IWER, 1 with multiview or outside XR). */
  views: number;
  /** Canvas redraws since install (proves the numbers update). */
  redraws: number;
  /** True while the panel is gliding back in front of the head. */
  following: boolean;
  /** The app-state lines currently printed. */
  app: string[];
  visible: boolean;
}

export interface DebugOverlayHandle {
  readonly object: Mesh;
  snapshot(): DebugOverlaySnapshot;
  setVisible(visible: boolean): void;
  dispose(): void;
}

declare global {
  interface Window {
    __debugOverlay?: DebugOverlayHandle;
  }
}

/** True when the page URL asks for the debug overlay (`?debug=1|true|on`). */
export function debugRequested(): boolean {
  try {
    const v = new URLSearchParams(location.search).get('debug');
    return v === '1' || v === 'true' || v === 'on' || v === '';
  } catch {
    return false;
  }
}

let current: DebugOverlayHandle | null = null;

/** The installed overlay (null until `installDebugOverlay` showed one). */
export function getDebugOverlay(): DebugOverlayHandle | null {
  return current;
}

// ------------------------------------------------------------------------------------------------ constants
const CAP = 512; // frame samples kept (2 s even at 250 Hz)
const WINDOW_MS = 2000;
const CW = 512; // canvas size (px); the panel keeps this aspect
const CH = 320;
const PANEL_W = 0.34; // metres: about 24 degrees wide at 0.8 m, ~21 px/deg (close to Quest 3's ~25 ppd)
const DEG = Math.PI / 180;
const FOLLOW_START_DEG = 14; // lazy follow: start gliding when the panel is this far off its slot...
const FOLLOW_STOP_DEG = 1; // ...and settle when it is this close
const FOLLOW_RATE = 4; // 1/s exponential approach

const css = (hex: number, a = 1): string => {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
};
const C = {
  bg: css(0x15100c, 0.86),
  border: css(PAL.brass, 0.7),
  text: css(PAL.text),
  dim: css(PAL.text, 0.55),
  faint: css(PAL.text, 0.16),
  good: css(PAL.target),
  warn: css(PAL.lampAmber),
  bad: css(PAL.alarm),
  gold: css(PAL.glintGold),
  blue: css(PAL.glintBlue),
};
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, "Roboto Mono", monospace';

/**
 * Show the debug overlay when the URL has `?debug=1` (or `opts.force`). Safe to call more than once and in 2D or XR.
 * The handle is also exposed as `window.__debugOverlay` for tests (`snapshot()` returns the live numbers).
 */
export function installDebugOverlay(world: World, opts: DebugOverlayOptions = {}): void {
  if (current) return;
  if (!opts.force && !debugRequested()) return;
  try {
    current = createOverlay(world, opts);
    window.__debugOverlay = current;
  } catch (e) {
    console.warn('[debug] overlay could not be created:', e);
  }
}

/** Placement presets for `?debugPos=` (degrees from the view centre). `low` is the default. */
const PRESETS: Record<string, [yaw: number, pitch: number]> = {
  low: [0, -22],
  left: [-30, -12],
  right: [30, -12],
  top: [0, 20],
};

/** URL overrides: `?debugPos=low|left|right|top`, or `?debugYaw=<deg>&debugPitch=<deg>`. */
function urlPlacement(): { yaw?: number; pitch?: number } {
  try {
    const q = new URLSearchParams(location.search);
    const preset = PRESETS[q.get('debugPos') ?? ''];
    const yaw = Number(q.get('debugYaw'));
    const pitch = Number(q.get('debugPitch'));
    return {
      yaw: q.has('debugYaw') && Number.isFinite(yaw) ? yaw : preset?.[0],
      pitch: q.has('debugPitch') && Number.isFinite(pitch) ? pitch : preset?.[1],
    };
  } catch {
    return {};
  }
}

function createOverlay(world: World, opts: DebugOverlayOptions): DebugOverlayHandle {
  const distance = opts.distance ?? 0.8;
  const fromUrl = urlPlacement();
  const pitchOff = (fromUrl.pitch ?? opts.pitchDeg ?? PRESETS.low[1]) * DEG;
  const yawOff = (fromUrl.yaw ?? opts.yawDeg ?? PRESETS.low[0]) * DEG;
  const refreshMs = 1000 / Math.max(0.5, opts.refreshHz ?? 4);

  // ---------------------------------------------------------------------------------------- canvas + mesh
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false, // always readable, even when the panel dips into the table
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const geometry = new PlaneGeometry(PANEL_W, (PANEL_W * CH) / CW);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'debug-overlay';
  mesh.renderOrder = 10_000;
  mesh.frustumCulled = false;
  mesh.userData.iwsdkRuntimeOnly = true; // keep it out of IWER target bounds
  // A static holder entity at the world origin; the panel is a plain child, so moving it every frame never goes
  // through the ECS-synced transform accessors (and never walks an entity parent chain).
  const holder = new Group();
  holder.name = 'debug-overlay-holder';
  holder.add(mesh);
  let entity: Entity | null = null;
  try {
    entity = world.createTransformEntity(holder, { persistent: true });
  } catch {
    world.scene.add(holder); // fallback for worlds without the transform system
  }

  // ---------------------------------------------------------------------------------------- stats state
  const intervals = new Float32Array(CAP);
  const stamps = new Float64Array(CAP);
  const scratch = new Float32Array(CAP);
  const graph = new Float32Array(160); // last frame intervals for the graph (oldest first when drawn)
  let ringHead = 0;
  let ringCount = 0;
  let graphHead = 0;
  let frames = 0;
  let redraws = 0;
  // hot doubles live in a typed array: closure-captured `let` doubles are re-boxed on every write
  const F = new Float64Array(4);
  const LAST_STAMP = 0;
  const EMA_MS = 1;
  const LAST_REDRAW = 2;
  const DESIRED_YAW = 3;
  F[LAST_STAMP] = -1;
  F[EMA_MS] = 16.7;
  F[LAST_REDRAW] = -1e9;
  const s: DebugOverlaySnapshot = {
    fps: 0,
    frameMsAvg: 0,
    frameMsP95: 0,
    frameMsMax: 0,
    windowFrames: 0,
    frames: 0,
    drawCalls: 0,
    drawCallsPerView: 0,
    triangles: 0,
    trianglesPerView: 0,
    programs: 0,
    geometries: 0,
    textures: 0,
    views: 1,
    redraws: 0,
    following: false,
    app: [],
    visible: true,
  };

  // ---------------------------------------------------------------------------------------- follow state
  const headPos = new Vector3();
  const fwd = new Vector3();
  const rel = new Vector3();
  const axisX = new Vector3();
  const axisY = new Vector3();
  const axisZ = new Vector3();
  const basis = new Matrix4();
  let placed = false;
  let following = false;
  let wasPresenting = false;
  let snapIn = 0; // frames until the panel snaps in front of the head (entering/leaving XR jumps the head pose)

  const readInfo = () => {
    const r = world.renderer;
    const info = r?.info;
    if (!info) return;
    s.drawCalls = info.render.calls;
    s.triangles = info.render.triangles;
    s.programs = info.programs ? info.programs.length : 0;
    s.geometries = info.memory.geometries;
    s.textures = info.memory.textures;
    const xr = r.xr as typeof r.xr & { isMultiview?: boolean };
    let views = 1;
    if (xr.isPresenting && !xr.isMultiview) views = Math.max(1, xr.getCamera().cameras.length);
    s.views = views;
    s.drawCallsPerView = Math.round(s.drawCalls / views);
    s.trianglesPerView = Math.round(s.triangles / views);
  };

  const pushFrame = (now: number) => {
    frames++;
    if (F[LAST_STAMP] >= 0) {
      const dt = now - F[LAST_STAMP];
      intervals[ringHead] = dt;
      stamps[ringHead] = now;
      ringHead = (ringHead + 1) % CAP;
      if (ringCount < CAP) ringCount++;
      graph[graphHead] = dt;
      graphHead = (graphHead + 1) % graph.length;
      const clamped = dt > 250 ? 250 : dt;
      F[EMA_MS] += (clamped - F[EMA_MS]) * (1 - Math.exp(-clamped / 400));
    }
    F[LAST_STAMP] = now;
  };

  const windowStats = (now: number) => {
    let n = 0;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < ringCount; i++) {
      const idx = (ringHead - 1 - i + CAP) % CAP;
      if (now - stamps[idx] > WINDOW_MS) break;
      const v = intervals[idx];
      scratch[n++] = v;
      sum += v;
      if (v > max) max = v;
    }
    s.windowFrames = n;
    s.frameMsAvg = n ? sum / n : 0;
    s.frameMsMax = max;
    s.frameMsP95 = n ? selectKth(scratch, n, Math.min(n - 1, Math.ceil(n * 0.95) - 1)) : 0;
    s.fps = F[EMA_MS] > 0 ? 1000 / F[EMA_MS] : 0;
    s.frames = frames;
  };

  const follow = (dt: number) => {
    const cam = world.camera;
    if (!cam) return;
    const presenting = !!world.renderer?.xr?.isPresenting;
    if (presenting !== wasPresenting) {
      wasPresenting = presenting;
      snapIn = 3; // the camera carries the XR viewer pose only after the next renders
    }
    if (snapIn > 0 && --snapIn === 0) placed = false;
    // the renderer refreshed the camera's matrixWorld from the viewer pose last frame (one frame of lag is fine)
    const e = cam.matrixWorld.elements;
    headPos.set(e[12], e[13], e[14]);
    fwd.set(-e[8], -e[9], -e[10]).normalize();
    if (Math.abs(fwd.y) < 0.97) F[DESIRED_YAW] = Math.atan2(fwd.x, -fwd.z) + yawOff;
    const desiredYaw = F[DESIRED_YAW];
    const headPitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    const desiredPitch = Math.max(-80 * DEG, Math.min(60 * DEG, headPitch + pitchOff));

    rel.copy(mesh.position).sub(headPos);
    let dist = rel.length();
    let curYaw = desiredYaw;
    let curPitch = desiredPitch;
    if (placed && dist > 1e-4) {
      curYaw = Math.atan2(rel.x, -rel.z);
      curPitch = Math.asin(Math.max(-1, Math.min(1, rel.y / dist)));
    } else {
      dist = distance;
    }
    let dYaw = desiredYaw - curYaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    const dPitch = desiredPitch - curPitch;
    const off = Math.hypot(dYaw * Math.cos(curPitch), dPitch);
    const dDist = distance - dist;
    if (!placed || off > FOLLOW_START_DEG * DEG || Math.abs(dDist) > 0.15) following = true;
    if (!placed || following) {
      const k = placed ? 1 - Math.exp(-dt * FOLLOW_RATE) : 1;
      const yaw = curYaw + dYaw * k;
      const pitch = curPitch + dPitch * k;
      const d = dist + dDist * k;
      const cp = Math.cos(pitch);
      mesh.position.set(
        headPos.x + Math.sin(yaw) * cp * d,
        headPos.y + Math.sin(pitch) * d,
        headPos.z - Math.cos(yaw) * cp * d,
      );
      placed = true;
      if (off * (1 - k) < FOLLOW_STOP_DEG * DEG && Math.abs(dDist * (1 - k)) < 0.01) following = false;
    }
    // face the head, upright: +Z toward the eyes, X level
    axisZ.copy(headPos).sub(mesh.position);
    if (axisZ.lengthSq() > 1e-8) {
      axisZ.normalize();
      axisX.set(axisZ.z, 0, -axisZ.x); // up x z
      if (axisX.lengthSq() < 1e-8) axisX.set(1, 0, 0);
      axisX.normalize();
      axisY.crossVectors(axisZ, axisX);
      mesh.quaternion.setFromRotationMatrix(basis.makeBasis(axisX, axisY, axisZ));
    }
    s.following = following;
  };

  // ---------------------------------------------------------------------------------------- drawing
  const appLines: string[] = [];
  const redraw = (now: number) => {
    windowStats(now);
    readAppState(appLines);
    s.app = appLines;
    s.redraws = ++redraws;
    const target = targetFps(world);
    const budgetMs = 1000 / target;

    ctx.clearRect(0, 0, CW, CH);
    roundRect(ctx, 3, 3, CW - 6, CH - 6, 22);
    ctx.fillStyle = C.bg;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.border;
    ctx.stroke();

    // header: FPS (left) and frame times (right)
    const fpsColor = s.fps >= target * 0.95 ? C.good : s.fps >= target * 0.75 ? C.warn : C.bad;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = fpsColor;
    ctx.font = `700 54px ${FONT}`;
    const fpsText = s.fps >= 100 ? s.fps.toFixed(0) : s.fps.toFixed(1);
    ctx.fillText(fpsText, 24, 70);
    const fpsW = ctx.measureText(fpsText).width;
    ctx.fillStyle = C.dim;
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(`FPS / ${target}`, 30 + fpsW, 68);

    ctx.textAlign = 'right';
    ctx.fillStyle = s.frameMsP95 > budgetMs * 1.05 ? C.warn : C.text;
    ctx.font = `600 26px ${MONO}`;
    ctx.fillText(`${s.frameMsAvg.toFixed(1)} ms`, CW - 24, 46);
    ctx.fillStyle = C.dim;
    ctx.font = `500 17px ${MONO}`;
    ctx.fillText(`p95 ${s.frameMsP95.toFixed(1)}  max ${s.frameMsMax.toFixed(1)}`, CW - 24, 72);

    // frame-time graph with the frame budget line
    const gx = 24;
    const gy = 88;
    const gw = CW - 48;
    const gh = 58;
    const scaleMs = Math.max(budgetMs * 2.2, 34);
    ctx.fillStyle = C.faint;
    ctx.fillRect(gx, gy, gw, gh);
    const n = graph.length;
    const bw = gw / n;
    for (let i = 0; i < n; i++) {
      const v = graph[(graphHead + i) % n];
      if (v <= 0) continue;
      const h = Math.min(gh, (v / scaleMs) * gh);
      ctx.fillStyle = v > budgetMs * 1.5 ? C.bad : v > budgetMs * 1.05 ? C.warn : C.good;
      ctx.fillRect(gx + i * bw, gy + gh - h, Math.max(1, bw - 0.6), h);
    }
    const by = gy + gh - (budgetMs / scaleMs) * gh;
    ctx.fillStyle = C.gold;
    ctx.fillRect(gx, by - 1, gw, 2);
    ctx.textAlign = 'left';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(`${budgetMs.toFixed(1)} ms`, gx + 4, by - 5);

    // stat chips
    const chips: Array<[string, string, string]> = [
      [
        s.views > 1 ? `DRAWS ×${s.views}v` : 'DRAWS',
        `${s.drawCallsPerView}`,
        s.drawCallsPerView > 70 ? C.bad : s.drawCallsPerView > 56 ? C.warn : C.text,
      ],
      ['TRIS', kilo(s.trianglesPerView), s.trianglesPerView > 300_000 ? C.bad : s.trianglesPerView > 200_000 ? C.warn : C.text],
      ['PROGS', `${s.programs}`, s.programs > 20 ? C.bad : s.programs > 16 ? C.warn : C.text],
      ['GEOS', `${s.geometries}`, C.text],
      ['TEX', `${s.textures}`, C.text],
    ];
    const cw = gw / chips.length;
    for (let i = 0; i < chips.length; i++) {
      const [label, value, color] = chips[i];
      const cx = gx + i * cw;
      ctx.fillStyle = C.dim;
      ctx.font = `700 13px ${FONT}`;
      ctx.fillText(label, cx, 172);
      ctx.fillStyle = color;
      ctx.font = `700 26px ${MONO}`;
      ctx.fillText(value, cx, 200);
    }

    // app state (window.__app.debugState())
    ctx.fillStyle = C.faint;
    ctx.fillRect(gx, 214, gw, 2);
    ctx.font = `500 18px ${MONO}`;
    if (appLines.length === 0) {
      ctx.fillStyle = C.dim;
      ctx.fillText('no window.__app (demo / boot)', gx, 244);
    } else {
      for (let i = 0; i < appLines.length && i < 4; i++) {
        ctx.fillStyle = i === 0 ? C.gold : C.text;
        ctx.fillText(fitText(ctx, appLines[i], gw), gx, 244 + i * 23);
      }
    }
    texture.needsUpdate = true;
  };

  const tick = (dt: number) => {
    try {
      const now = performance.now();
      pushFrame(now);
      readInfo();
      if (!mesh.visible) return;
      follow(dt);
      if (now - F[LAST_REDRAW] >= refreshMs) {
        F[LAST_REDRAW] = now;
        redraw(now);
      }
    } catch (e) {
      // Never let the overlay break the frame; report once.
      if (!warned) {
        warned = true;
        console.warn('[debug] overlay tick failed:', e);
      }
    }
  };
  let warned = false;
  const stop = onUpdate(world, tick);

  const handle: DebugOverlayHandle = {
    object: mesh,
    snapshot() {
      windowStats(performance.now());
      s.visible = mesh.visible;
      return { ...s, app: [...s.app] };
    },
    setVisible(visible: boolean) {
      mesh.visible = visible;
      if (visible) placed = false; // snap back in front of the head
    },
    dispose() {
      stop();
      try {
        texture.dispose();
        material.dispose();
        geometry.dispose();
        if (entity) entity.dispose();
        else holder.removeFromParent();
      } catch {
        holder.removeFromParent();
      }
      if (current === handle) current = null;
      if (window.__debugOverlay === handle) delete window.__debugOverlay;
    },
  };
  return handle;
}

// ------------------------------------------------------------------------------------------------ helpers
/** Display refresh the frame budget is measured against. IWER (desktop emulator) runs at the browser's rAF rate. */
function targetFps(world: World): number {
  const emulated = typeof window !== 'undefined' && 'IWER_DEVICE' in window;
  const rate = world.session?.frameRate;
  if (world.renderer?.xr?.isPresenting && !emulated && typeof rate === 'number' && rate > 0) return Math.round(rate);
  return world.renderer?.xr?.isPresenting && !emulated ? 72 : 60;
}

/** k-th smallest of the first `n` values (in place, no allocation). */
function selectKth(a: Float32Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

function kilo(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${v}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? `${v}` : v.toFixed(2);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.length ? v.map(fmt).join(' ') : '–';
  try {
    const j = JSON.stringify(v);
    return j.length > 28 ? `${j.slice(0, 27)}…` : j;
  } catch {
    return String(v);
  }
}

const KNOWN = new Set(['act', 'beat', 'beatKind', 'paused', 'gazeTarget', 'watchers', 'palmed', 'loaded', 'caught', 'stars', 'calibrated']);

/** Summarise `window.__app.debugState()` into at most 4 short lines (empty when there is no app). */
function readAppState(out: string[]): void {
  out.length = 0;
  let st: Record<string, unknown> | null = null;
  try {
    st = window.__app?.debugState?.() ?? null;
  } catch (e) {
    out.push(`debugState() threw: ${String((e as Error)?.message ?? e)}`);
    return;
  }
  if (!st || typeof st !== 'object') return;
  const has = (k: string) => k in st!;
  const head = `ACT ${fmt(st.act)} · BEAT ${fmt(st.beat)}${has('beatKind') ? ` ${fmt(st.beatKind)}` : ''}${st.paused ? ' · PAUSED' : ''}`;
  out.push(head);
  out.push(`gaze ${fmt(st.gazeTarget)} · watchers ${fmt(st.watchers)}`);
  out.push(`palmed ${fmt(st.palmed)} · loaded ${fmt(st.loaded)} · caught ${fmt(st.caught)}`);
  let last = `stars ${fmt(st.stars)} · calib ${fmt(st.calibrated)}`;
  for (const k of Object.keys(st)) {
    if (KNOWN.has(k)) continue;
    last += ` · ${k} ${fmt(st[k])}`;
  }
  out.push(last);
}
