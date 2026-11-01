// Vintage magic-show posters pinned to the café wall (one per finished show). All posters share one atlas
// texture and one merged mesh (poster + drop-shadow quads) → one draw call. The newest poster pops on.
import {
  BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type BufferGeometry,
  type Object3D,
} from '@iwsdk/core';
import type { PosterData } from '../contracts.js';
import { mergeParts, type Part } from '../art/geometry.js';
import { L } from '../layout.js';
import { clamp01, easeOutBack, rng } from './anim.js';
import {
  createCanvasTexture,
  drawStars,
  fitWrapped,
  flourish,
  font,
  goldGradient,
  grain,
  setTracking,
  vignette,
  type CanvasTex,
} from './canvas.js';
import type { UICtx } from './context.js';
import { FONT_BODY, FONT_DISPLAY } from './fonts.js';

const AW = 2048;
const AH = 1024;
const CELL_W = 336;
const CELL_H = 496;
const COLS = 6;
const MAX = 12;
const POSTER_W = 0.25;
const POSTER_H = (POSTER_W * CELL_H) / CELL_W;
const SHADOW_PX = [2040, 1000, 6, 6] as const; // a dark patch in the atlas for drop-shadow quads

const SCHEMES = [
  { bg: '#8e1f23', bg2: '#5a0f14', ink: '#fff4dc', accent: '#ffcf5a' },
  { bg: '#1c2452', bg2: '#0b1030', ink: '#fff4dc', accent: '#ffcf5a' },
  { bg: '#d6a23a', bg2: '#a8741f', ink: '#241a12', accent: '#8e1f23' },
  { bg: '#1f5a5a', bg2: '#0f3333', ink: '#fff4dc', accent: '#ffcf5a' },
];

export class Posters {
  readonly group = new Group();
  private readonly ct: CanvasTex;
  private readonly mat: MeshBasicMaterial;
  private mesh: Mesh | null = null;
  private count = 0;
  private readonly pop = { value: 1 };
  private popT = 1;

  constructor(
    ctx: UICtx,
    wall: Object3D | null,
  ) {
    this.ct = createCanvasTexture(AW, AH, ctx.anisotropy);
    this.mat = new MeshBasicMaterial({ map: this.ct.texture, color: 0xf0e4cf, toneMapped: true });
    this.mat.name = 'ui-posters';
    const pop = this.pop;
    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.uPop = pop;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aPop;\nuniform float uPop;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           transformed = aPop.xyz + (transformed - aPop.xyz) * mix(1.0, uPop, aPop.w);`,
        );
    };
    this.mat.customProgramCacheKey = () => 'ui-posters-pop-v1';
    this.group.name = 'ui-posters';
    if (wall) {
      // the café's poster wall faces the player (+Z); sit a few mm proud of it
      this.group.position.set(0, 0, 0.006);
      wall.add(this.group);
    } else {
      this.group.position.set(L.posterWall.centerX, L.posterWall.centerY, L.posterWall.z + 0.01);
      ctx.root.add(this.group);
    }
    const c = this.ct.ctx;
    c.fillStyle = '#0a080c';
    c.fillRect(SHADOW_PX[0], SHADOW_PX[1], SHADOW_PX[2], SHADOW_PX[3]);
  }

  set(list: PosterData[]): void {
    const shown = list.slice(-MAX);
    const grew = list.length > this.count && this.count > 0;
    this.count = list.length;
    const c = this.ct.ctx;
    c.save();
    c.clearRect(0, 0, AW, SHADOW_PX[1] - 2);
    shown.forEach((p, i) => {
      const x = (i % COLS) * (CELL_W + 4);
      const y = Math.floor(i / COLS) * CELL_H;
      drawPoster(c, x, y, CELL_W, CELL_H, p, list.length - shown.length + i);
    });
    c.restore();
    this.ct.texture.needsUpdate = true;
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (!shown.length) return;
    this.mesh = new Mesh(this.layout(shown.length, grew), this.mat);
    this.mesh.name = 'ui-posters-mesh';
    this.group.add(this.mesh);
    this.popT = grew ? 0 : 1;
    this.pop.value = grew ? 0 : 1;
  }

  private layout(n: number, newestPops: boolean): BufferGeometry {
    const rows = n > 6 ? 2 : 1;
    const perRow = Math.ceil(n / rows);
    const gapX = Math.min(0.31, (L.posterWall.width - 0.1) / perRow);
    const r = rng(1234);
    const parts: Part[] = [];
    const pops: number[] = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, n - row * perRow);
      const x = (col - (inRow - 1) / 2) * gapX + (r() - 0.5) * 0.02;
      const y = (rows === 2 ? (row === 0 ? 0.21 : -0.21) : 0) + (r() - 0.5) * 0.03;
      const rot = (r() - 0.5) * 0.09;
      const isNew = newestPops && i === n - 1 ? 1 : 0;
      // drop shadow (offset down-right, behind)
      const sh = new PlaneGeometry(POSTER_W, POSTER_H);
      setUvRect(sh, SHADOW_PX[0] + 1, SHADOW_PX[1] + 1, SHADOW_PX[2] - 2, SHADOW_PX[3] - 2);
      parts.push({ geometry: sh, color: 0xffffff, position: [x + 0.007, y - 0.009, -0.002], rotation: [0, 0, rot] });
      pops.push(x, y, 0, isNew);
      const pg = new PlaneGeometry(POSTER_W, POSTER_H);
      setUvRect(pg, (i % COLS) * (CELL_W + 4) + 2, Math.floor(i / COLS) * CELL_H + 2, CELL_W - 4, CELL_H - 4);
      parts.push({ geometry: pg, color: 0xffffff, position: [x, y, 0], rotation: [0, 0, rot] });
      pops.push(x, y, 0, isNew);
    }
    const geo = mergeParts(parts, { keepUv: true });
    const per = parts.map((p) => (p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count));
    const aPop = new Float32Array(geo.getAttribute('position').count * 4);
    let o = 0;
    per.forEach((cnt, k) => {
      for (let v = 0; v < cnt; v++) aPop.set(pops.slice(k * 4, k * 4 + 4), (o + v) * 4);
      o += cnt;
    });
    geo.setAttribute('aPop', new BufferAttribute(aPop, 4));
    for (const p of parts) p.geometry.dispose();
    return geo;
  }

  update(dt: number): void {
    if (this.popT >= 1) return;
    this.popT = Math.min(1, this.popT + dt / 0.7);
    this.pop.value = easeOutBack(clamp01(this.popT), 2.4);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh?.geometry.dispose();
    this.mat.dispose();
    this.ct.texture.dispose();
  }
}

function setUvRect(g: PlaneGeometry, x: number, y: number, w: number, h: number): void {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, (x + u * w) / AW, 1 - (y + (1 - v) * h) / AH);
  }
}

/** A vintage magic-show poster: all-seeing eye with sunburst, title, stars, date ribbon, pinned with a tack. */
function drawPoster(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, p: PosterData, index: number): void {
  const s = SCHEMES[index % SCHEMES.length];
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  const bg = c.createLinearGradient(0, y, 0, y + h);
  bg.addColorStop(0, s.bg);
  bg.addColorStop(1, s.bg2);
  c.fillStyle = bg;
  c.fillRect(x, y, w, h);
  // sunburst rays behind the eye
  const cx = x + w / 2;
  const cy = y + h * 0.4;
  c.save();
  c.translate(cx, cy);
  for (let i = 0; i < 24; i++) {
    c.rotate((Math.PI * 2) / 24);
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(-18, -h);
    c.lineTo(18, -h);
    c.closePath();
    c.fillStyle = i % 2 ? 'rgba(255,240,200,0.07)' : 'rgba(0,0,0,0.06)';
    c.fill();
  }
  c.restore();
  // the all-seeing eye
  c.save();
  c.translate(cx, cy);
  c.beginPath();
  c.moveTo(-92, 0);
  c.quadraticCurveTo(0, -78, 92, 0);
  c.quadraticCurveTo(0, 78, -92, 0);
  c.closePath();
  c.fillStyle = '#fff4dc';
  c.fill();
  c.lineWidth = 7;
  c.strokeStyle = s.accent === '#8e1f23' ? '#241a12' : s.accent;
  c.stroke();
  c.beginPath();
  c.arc(0, 0, 34, 0, Math.PI * 2);
  c.fillStyle = s.bg2;
  c.fill();
  c.beginPath();
  c.arc(0, 0, 16, 0, Math.PI * 2);
  c.fillStyle = '#100c08';
  c.fill();
  c.beginPath();
  c.arc(-9, -10, 7, 0, Math.PI * 2);
  c.fillStyle = '#ffffff';
  c.fill();
  // lashes
  c.strokeStyle = s.accent === '#8e1f23' ? '#241a12' : s.accent;
  c.lineWidth = 6;
  c.lineCap = 'round';
  for (let i = -2; i <= 2; i++) {
    const a = -Math.PI / 2 + i * 0.32;
    c.beginPath();
    c.moveTo(Math.cos(a) * 52, Math.sin(a) * 40 - 6);
    c.lineTo(Math.cos(a) * 70, Math.sin(a) * 58 - 6);
    c.stroke();
  }
  c.restore();
  // header
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.fillStyle = s.ink;
  c.font = font(800, 24, FONT_BODY);
  setTracking(c, 6);
  c.fillText(index === 0 ? 'TONIGHT ONLY' : 'HELD OVER!', cx, y + 56);
  setTracking(c, 0);
  flourish(c, cx, y + 72, 170, s.accent, 2.5);
  // title
  const fit = fitWrapped(c, p.title || 'Sleight of Eye', 800, FONT_DISPLAY, 56, 28, w - 52, 2);
  c.font = font(800, fit.px, FONT_DISPLAY);
  const lh = fit.px * 1.02;
  let ty = y + h * 0.7 - ((fit.lines.length - 1) * lh) / 2;
  for (const line of fit.lines) {
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillText(line, cx + 2, ty + 3);
    c.fillStyle = s.ink === '#241a12' ? s.ink : goldGradient(c, ty - fit.px, ty);
    c.fillText(line, cx, ty);
    ty += lh;
  }
  // stars
  drawStars(c, cx, y + h * 0.82, 15, Math.max(0, Math.min(3, Math.round(p.stars))), 3, {
    fill: s.ink === '#241a12' ? '#8e1f23' : '#ffcf5a',
    stroke: s.ink === '#241a12' ? '#241a12' : 'rgba(0,0,0,0.6)',
    empty: 'rgba(0,0,0,0.18)',
    gap: 40,
    lineWidth: 2.5,
  });
  // date ribbon
  const ry = y + h - 58;
  c.fillStyle = s.accent;
  c.beginPath();
  c.moveTo(x + 26, ry);
  c.lineTo(x + w - 26, ry);
  c.lineTo(x + w - 40, ry + 19);
  c.lineTo(x + w - 26, ry + 38);
  c.lineTo(x + 26, ry + 38);
  c.lineTo(x + 40, ry + 19);
  c.closePath();
  c.fill();
  c.fillStyle = s.accent === '#ffcf5a' ? '#241a12' : '#fff4dc';
  c.font = font(800, 21, FONT_BODY);
  setTracking(c, 3);
  c.fillText((p.date || '').toUpperCase(), cx, ry + 27);
  setTracking(c, 0);
  // border, age, tack
  c.strokeStyle = s.ink;
  c.globalAlpha = 0.7;
  c.lineWidth = 4;
  c.strokeRect(x + 12, y + 12, w - 24, h - 24);
  c.lineWidth = 1.5;
  c.strokeRect(x + 19, y + 19, w - 38, h - 38);
  c.globalAlpha = 1;
  grain(c, x, y, w, h, 0.03, 100 + index, true);
  vignette(c, x, y, w, h, 'rgba(40,20,5,1)', 0.35);
  c.beginPath();
  c.arc(cx, y + 18, 8, 0, Math.PI * 2);
  c.fillStyle = goldGradient(c, y + 10, y + 26);
  c.fill();
  c.restore();
}
