// "The Midnight Gazette": the bow's newspaper review, propped on a little brass stand on the mat facing the
// player. Masthead, headline, stars per act, a halftone "photo", Brock's quote. One mesh (paper + stand share
// one canvas texture), matcap-shaded so the curl and fold catch the lamp; flies in with a flutter.
import {
  BoxGeometry,
  CapsuleGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshMatcapMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from '@iwsdk/core';
import type { ReviewData } from '../contracts.js';
import { mergeParts } from '../art/geometry.js';
import { makeMatcap } from '../art/matcap.js';
import { L } from '../layout.js';
import { clamp01, easeOutCubic } from './anim.js';
import {
  createCanvasTexture,
  drawStars,
  fitWrapped,
  font,
  grain,
  setTracking,
  vignette,
  type CanvasTex,
} from './canvas.js';
import type { UICtx } from './context.js';
import { FONT_BODY, FONT_DISPLAY } from './fonts.js';

const PW = 0.19; // paper width (m)
const PH = 0.258;
// The page is designed at 1024×1390 and drawn at ×1.25 (1280 px on a 19 cm page ≈ 6700 px/m: ~2× the Quest 3
// display density at ~0.42 m). The big canvas is only created the first time the review is shown.
const DRAW_SCALE = 1.25;
const DESIGN_W = 1024;
const DESIGN_H = 1390;
const ART_W = Math.round(DESIGN_W * DRAW_SCALE);
const ART_H = Math.round(DESIGN_H * DRAW_SCALE);
const STRIP = 30;
const GAP = 12;
const CANVAS_H = ART_H + GAP + STRIP;
const LEAN = 60 * (Math.PI / 180); // from vertical: the top edge stays below the audience's faces
const BASE: [number, number, number] = [0, L.tableY + 0.004, -0.255];
const ACT_NAMES = ['The Vanishing Coin', 'Cups & Ball', "The Critic's Watch"];
const SETTLED = 3; // s: landed (0.85 s) and the glint has swept past the page
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function curlZ(y: number): number {
  const t = y / PH;
  const fold = Math.max(0, 1 - Math.abs(y - PH * 0.52) / 0.05);
  return -0.016 * t * t + 0.0035 * fold * fold;
}

function buildGeometry(): BufferGeometry {
  const v0 = (STRIP + GAP) / CANVAS_H;
  const paper = new PlaneGeometry(PW, PH, 1, 24);
  paper.translate(0, PH / 2, 0);
  const pos = paper.getAttribute('position');
  const uv = paper.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, curlZ(pos.getY(i)));
    uv.setY(i, v0 + uv.getY(i) * (1 - v0));
  }
  paper.computeVertexNormals();
  const brassUv = (g: BufferGeometry) => {
    const a = g.getAttribute('uv');
    for (let i = 0; i < a.count; i++) a.setXY(i, 0.05 + a.getX(i) * 0.9, (0.15 + a.getY(i) * 0.7) * (STRIP / CANVAS_H));
    return g;
  };
  // brass ledge holding the bottom edge
  const ledge = brassUv(new BoxGeometry(PW + 0.014, 0.008, 0.014));
  const lip = brassUv(new BoxGeometry(PW + 0.014, 0.0095, 0.003));
  // back leg: from behind the paper's middle straight down (rig vertical) to the tabletop
  const rot = new Matrix4().makeRotationX(-LEAN);
  const start = new Vector3(0, PH * 0.55, curlZ(PH * 0.55) - 0.004);
  const startRig = start.clone().applyMatrix4(rot); // relative to BASE
  const drop = startRig.y + (BASE[1] - L.tableY);
  const endLocal = new Vector3(startRig.x, startRig.y - drop, startRig.z).applyMatrix4(rot.clone().invert());
  const dir = endLocal.clone().sub(start);
  const len = dir.length();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  const mid = start.clone().addScaledVector(dir, 0.5);
  const leg = brassUv(new CapsuleGeometry(0.0028, len, 3, 8));
  const geo = mergeParts(
    [
      { geometry: paper, color: 0xffffff },
      { geometry: ledge, color: 0xffffff, position: [0, 0.002, 0.007] },
      { geometry: lip, color: 0xffffff, position: [0, 0.0045, 0.0135] },
      { geometry: leg, color: 0xffffff, position: [mid.x, mid.y, mid.z], rotation: [e.x, e.y, e.z] },
    ],
    { keepUv: true },
  );
  for (const g of [paper, ledge, lip, leg]) g.dispose();
  return geo;
}

export class Review {
  readonly group = new Group();
  private readonly mesh: Mesh;
  private readonly mat: MeshMatcapMaterial;
  private ct: CanvasTex | null = null;
  private readonly placeholder: CanvasTex;
  private readonly anisotropy: number;
  private t = -1;
  private readonly glint = { value: -1 };

  constructor(ctx: UICtx) {
    this.anisotropy = ctx.anisotropy;
    // tiny stand-in map until the first review (same shader program, ~no memory)
    this.placeholder = createCanvasTexture(4, 4, 1);
    this.placeholder.ctx.fillStyle = '#efe6d2';
    this.placeholder.ctx.fillRect(0, 0, 4, 4);
    this.mat = new MeshMatcapMaterial({
      map: this.placeholder.texture,
      matcap: makeMatcap({
        base: 0xf2ece2,
        key: 0xfff0d6,
        keyStrength: 0.22,
        rim: 0xfff6e8,
        rimStrength: 0.12,
        rimPower: 3,
        spec: 0.12,
        specSize: 0.6,
      }),
      toneMapped: false,
    });
    this.mat.name = 'ui-review';
    const glint = this.glint;
    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGlint = glint;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uGlint;')
        .replace(
          '#include <opaque_fragment>',
          `#ifdef USE_MAP
             float gd = (vMapUv.x * 0.6 + (1.0 - vMapUv.y)) * 0.62 - uGlint;
             outgoingLight += vec3(1.0, 0.93, 0.78) * exp(-gd * gd * 220.0) * 0.32;
           #endif
           #include <opaque_fragment>`,
        );
    };
    this.mat.customProgramCacheKey = () => 'ui-review-glint-v1';
    this.mesh = new Mesh(buildGeometry(), this.mat);
    this.mesh.name = 'ui-review-paper';
    this.group.name = 'ui-review';
    this.group.add(this.mesh);
    this.group.visible = false;
    ctx.root.add(this.group);
  }

  private canvas(): CanvasTex {
    if (this.ct) return this.ct;
    const ct = createCanvasTexture(ART_W, CANVAS_H, this.anisotropy);
    // brass strip for the stand
    const g = ct.ctx.createLinearGradient(0, ART_H + GAP, 0, CANVAS_H);
    g.addColorStop(0, '#8a5f1c');
    g.addColorStop(0.5, '#ffd978');
    g.addColorStop(1, '#7a5418');
    ct.ctx.fillStyle = g;
    ct.ctx.fillRect(0, ART_H + GAP, ART_W, STRIP);
    this.ct = ct;
    this.mat.map = ct.texture;
    return ct;
  }

  show(data: ReviewData): void {
    const ct = this.canvas();
    const c = ct.ctx;
    c.save();
    c.clearRect(0, 0, ART_W, ART_H + GAP);
    c.scale(DRAW_SCALE, DRAW_SCALE);
    drawGazette(c, DESIGN_W, DESIGN_H, data);
    c.restore();
    ct.texture.needsUpdate = true;
    this.t = 0;
    this.group.visible = true;
  }

  hide(): void {
    this.t = -1;
    this.group.visible = false;
  }

  update(dt: number): void {
    // after the toss and the glint sweep the page rests: no per-frame work while it stays on the stand
    if (this.t < 0 || this.t > SETTLED) return;
    this.t += dt;
    // toss in from above the stage, flutter, settle onto the stand
    const u = clamp01(this.t / 0.85);
    const k = easeOutCubic(u);
    const flutter = Math.sin(this.t * 13) * (1 - u) * 0.22;
    this.group.position.set(BASE[0] + (1 - k) * 0.04, BASE[1] + (1 - k) * 0.22 + Math.sin(u * Math.PI) * 0.02, BASE[2] - (1 - k) * 0.12);
    this.group.rotation.set(-LEAN - (1 - k) * 0.9, (1 - k) * 0.35 + flutter * 0.4, flutter);
    // a glint sweeps across once it lands
    this.glint.value = this.t < 0.8 ? -1 : -0.2 + (this.t - 0.8) * 1.1;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.ct?.texture.dispose();
    this.placeholder.texture.dispose();
  }
}

// ------------------------------------------------------------------------------------------- the page
const INK = '#241a12';
const INK_SOFT = 'rgba(36,26,18,0.72)';

function rule(c: CanvasRenderingContext2D, x0: number, x1: number, y: number, w: number): void {
  c.fillStyle = INK;
  c.fillRect(x0, y, x1 - x0, w);
}

function drawGazette(c: CanvasRenderingContext2D, W: number, H: number, data: ReviewData): void {
  // newsprint
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#f4ecda');
  bg.addColorStop(1, '#eadfc6');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  grain(c, 0, 0, W, H, 0.02, 11);
  vignette(c, 0, 0, W, H, 'rgba(150,110,50,1)', 0.18);
  // the fold
  const fy = H * 0.5;
  const fold = c.createLinearGradient(0, fy - 14, 0, fy + 14);
  fold.addColorStop(0, 'rgba(120,90,50,0)');
  fold.addColorStop(0.5, 'rgba(120,90,50,0.14)');
  fold.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = fold;
  c.fillRect(0, fy - 14, W, 28);

  const M = 44;
  c.textBaseline = 'alphabetic';
  // ---- ears + tagline (y 30..64)
  rule(c, M, W - M, 30, 3);
  c.font = font(800, 21, FONT_BODY);
  setTracking(c, 3);
  c.fillStyle = INK;
  c.textAlign = 'left';
  c.fillText('VOL. I · No. 31', M, 60);
  c.textAlign = 'right';
  c.fillText('ONE PENNY', W - M, 60);
  c.textAlign = 'center';
  c.fillText('ALL THE MAGIC FIT TO PRINT', W / 2, 60);
  setTracking(c, 0);
  // ---- masthead (baseline 160)
  const mast = fitWrapped(c, 'The Midnight Gazette', 900, FONT_DISPLAY, 116, 60, W - M * 2, 1);
  c.font = font(900, mast.px, FONT_DISPLAY);
  c.fillStyle = INK;
  c.fillText('The Midnight Gazette', W / 2, 160);
  // crescent moon between two rules
  c.save();
  c.translate(W / 2, 186);
  c.fillStyle = INK;
  c.beginPath();
  c.arc(0, 0, 11, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#f1e8d4';
  c.beginPath();
  c.arc(5, -3, 10, 0, Math.PI * 2);
  c.fill();
  c.restore();
  rule(c, M, W / 2 - 30, 185, 2);
  rule(c, W / 2 + 30, W - M, 185, 2);
  // ---- dateline (y 202..250)
  rule(c, M, W - M, 204, 4);
  rule(c, M, W - M, 212, 1.5);
  let date = '';
  try {
    date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    date = 'Tonight';
  }
  c.font = font(700, 19, FONT_BODY);
  setTracking(c, 2);
  c.textAlign = 'left';
  c.fillText(date.toUpperCase(), M, 238);
  c.textAlign = 'center';
  c.fillText('MIDNIGHT EDITION', W / 2, 238);
  c.textAlign = 'right';
  c.fillText('WEATHER: STARRY', W - M, 238);
  setTracking(c, 0);
  rule(c, M, W - M, 250, 1.5);
  // ---- headline (y 262..~540)
  const head = fitWrapped(c, (data.headline || 'Magic!').toUpperCase(), 900, FONT_DISPLAY, 98, 52, W - M * 2, 3);
  c.font = font(900, head.px, FONT_DISPLAY);
  c.textAlign = 'center';
  const hl = head.px * 0.98;
  const headTop = 262 + head.px * 0.86;
  head.lines.forEach((line, i) => c.fillText(line, W / 2, headTop + i * hl));
  let y = headTop + (head.lines.length - 1) * hl + head.px * 0.18;
  c.font = font(400, 32, FONT_DISPLAY, true);
  c.fillStyle = INK_SOFT;
  c.fillText('A tiny felt audience could not believe its eyes', W / 2, y + 40);
  y += 62;
  rule(c, M, W - M, y, 2);
  // ---- two columns: the notices | the photograph
  const colTop = y + 18;
  const split = 528;
  c.fillStyle = INK;
  c.font = font(900, 23, FONT_BODY);
  setTracking(c, 4);
  c.textAlign = 'left';
  c.fillText('THE NOTICES', M, colTop + 22);
  setTracking(c, 0);
  rule(c, M, split - 20, colTop + 33, 1.5);
  const acts = data.stars.length ? data.stars : [0, 0, 0];
  const rowH = Math.min(112, 336 / acts.length);
  acts.forEach((stars, i) => {
    const ry = colTop + 44 + i * rowH;
    c.fillStyle = INK_SOFT;
    c.font = font(800, 19, FONT_BODY);
    setTracking(c, 3);
    c.fillText(`ACT ${ROMAN[i] ?? i + 1}`, M, ry + 17);
    setTracking(c, 0);
    c.fillStyle = INK;
    const name = ACT_NAMES[i] ?? 'Encore';
    const nf = fitWrapped(c, name, 700, FONT_DISPLAY, 36, 24, split - M - 30, 1);
    c.font = font(700, nf.px, FONT_DISPLAY);
    c.fillText(name, M, ry + 52);
    const s = Math.max(0, Math.min(3, Math.round(stars)));
    drawStars(c, M + 24 + 54, ry + 84, 21, s, 3, { fill: '#d39b2e', stroke: INK, gap: 54, lineWidth: 3.5 });
    c.font = font(400, 22, FONT_DISPLAY, true);
    c.fillStyle = INK_SOFT;
    c.fillText(['Unfinished.', 'Done.', 'Clean!', 'Flawless!'][s], M + 190, ry + 92);
  });
  // photograph (halftone)
  const px = split + 6;
  const pw = W - M - px;
  const ph = 262;
  halftone(c, px, colTop + 6, pw, ph);
  c.strokeStyle = INK;
  c.lineWidth = 3;
  c.strokeRect(px, colTop + 6, pw, ph);
  c.font = font(400, 21, FONT_DISPLAY, true);
  c.fillStyle = INK_SOFT;
  c.textAlign = 'center';
  c.fillText('Pictured: the audience, moments later.', px + pw / 2, colTop + ph + 36);
  fauxText(c, px, colTop + ph + 54, pw, 2, 22);
  // ---- the critic's quote (big: it is the punchline)
  const qTop = colTop + 44 + rowH * Math.min(3, acts.length) + 10;
  rule(c, M, W - M, qTop, 2);
  c.fillStyle = '#b7863a';
  c.font = font(900, 150, FONT_DISPLAY);
  c.textAlign = 'left';
  c.fillText('“', M - 8, qTop + 118);
  const quote = data.quote || 'Astonishing.';
  const room = H - 96 - (qTop + 20) - 52; // leave the attribution and the ledge margin clear
  // prefer two generous lines; fall back to three (avoids a lonely last word)
  let qf = fitWrapped(c, quote, 400, FONT_DISPLAY, 62, 48, W - M * 2 - 110, 2, true);
  if (qf.lines.length > 2) qf = fitWrapped(c, quote, 400, FONT_DISPLAY, 58, 34, W - M * 2 - 110, 3, true);
  c.font = font(400, qf.px, FONT_DISPLAY, true);
  c.fillStyle = INK;
  c.textAlign = 'center';
  const ql = qf.px * 1.16;
  const block = ql * (qf.lines.length - 1) + qf.px;
  let qy = qTop + 20 + Math.max(0, (room - block) / 2) + qf.px * 0.82;
  for (const line of qf.lines) {
    c.fillText(line, W / 2 + 34, qy);
    qy += ql;
  }
  // attribution with a tiny badger (kept clear of the brass ledge along the bottom edge)
  const ay = Math.min(qy + 6, H - 110);
  c.font = font(800, 24, FONT_BODY);
  setTracking(c, 2);
  c.textAlign = 'right';
  c.fillText('— SIR BROCK, CRITIC', W - M - 52, ay);
  setTracking(c, 0);
  badger(c, W - M - 22, ay - 8, 18);
  rule(c, M, W - M, H - 86, 1.5);
}

function fauxText(c: CanvasRenderingContext2D, x: number, y: number, w: number, lines: number, step: number): void {
  c.fillStyle = 'rgba(36,26,18,0.28)';
  for (let i = 0; i < lines; i++) {
    const lw = i === lines - 1 ? w * 0.62 : w * (0.92 + 0.08 * Math.sin(i * 3.1));
    c.fillRect(x, y + i * step, lw, 7);
  }
}

function badger(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.save();
  c.translate(x, y);
  c.fillStyle = '#8a8d93';
  c.beginPath();
  c.ellipse(0, 0, r, r * 0.9, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#f2f2f2';
  c.beginPath();
  c.ellipse(0, -1, r * 0.32, r * 0.88, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = INK;
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(s * r * 0.5, -r * 0.1, r * 0.16, r * 0.22, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.beginPath();
  c.arc(0, r * 0.55, r * 0.14, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = '#c99a3c';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(r * 0.5, -r * 0.1, r * 0.3, 0, Math.PI * 2); // the monocle
  c.stroke();
  c.restore();
}

/** Procedural halftone "photo": a top hat, a wand, sparkles, and a row of little felt heads. */
function halftone(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  c.save();
  c.fillStyle = '#e9dec4';
  c.fillRect(x, y, w, h);
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  const step = 8;
  const darkness = (u: number, v: number): number => {
    // u, v in 0..1 over the photo
    let d = 0.18 + 0.32 * Math.hypot(u - 0.5, (v - 0.35) * 0.9); // spotlit backdrop
    // top hat
    const hx = 0.5;
    if (Math.abs(u - hx) < 0.13 && v > 0.16 && v < 0.5) d = 0.92;
    if (Math.abs(u - hx) < 0.13 && v > 0.42 && v < 0.47) d = 0.55; // hat band
    if (((u - hx) / 0.22) ** 2 + ((v - 0.5) / 0.05) ** 2 < 1) d = 0.95;
    // wand
    const wu = u - 0.66;
    const wv = v - 0.3;
    const along = wu * 0.8 - wv * 0.6;
    const across = wu * 0.6 + wv * 0.8;
    if (Math.abs(across) < 0.018 && along > -0.02 && along < 0.26) d = along > 0.2 ? 0.15 : 0.95;
    // sparkles
    for (const [sx, sy, sr] of [
      [0.86, 0.12, 0.06],
      [0.2, 0.18, 0.05],
      [0.3, 0.06, 0.035],
    ]) {
      const ax = Math.abs(u - sx);
      const ay = Math.abs(v - sy) * 0.75;
      if ((ax < sr && ay < 0.012) || (ay < sr * 0.75 && ax < 0.012)) d = 0.05;
    }
    // audience heads along the bottom, ears up
    for (let k = 0; k < 5; k++) {
      const cx = 0.1 + k * 0.2;
      const cy = 0.86;
      const rr = Math.hypot(u - cx, (v - cy) * 0.8);
      if (rr < 0.075) d = 0.82;
      for (const s of [-1, 1]) {
        const ex = u - (cx + s * 0.045);
        const ey = v - (cy - 0.085);
        if (ey > -0.05 && ey < 0.03 && Math.abs(ex) < 0.022 * (1 - (ey + 0.05) / 0.08) + 0.004) d = 0.82;
      }
      if (rr < 0.075 && Math.abs(u - cx) < 0.04 && Math.abs(v - cy + 0.005) < 0.015) d = 0.2; // eyes
    }
    return Math.min(1, Math.max(0, d));
  };
  c.fillStyle = '#2a2018';
  for (let j = 0; j <= h / step; j++) {
    for (let i = 0; i <= w / step; i++) {
      const ox = j % 2 ? step / 2 : 0;
      const px = x + i * step + ox;
      const py = y + j * step;
      const dk = darkness((px - x) / w, (py - y) / h);
      const r = Math.sqrt(dk) * step * 0.62;
      if (r < 0.4) continue;
      c.beginPath();
      c.arc(px, py, r, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
}
