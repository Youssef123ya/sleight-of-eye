// Canvas-texture helpers: crisp sRGB text textures with mipmaps + anisotropy, and 2D drawing utilities
// (rounded paths, wrapping, stars, ornaments, paper grain) shared by every UI element.
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
} from '@iwsdk/core';
import { rng } from './anim.js';

export interface CanvasTex {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
}

/** A canvas + sRGB CanvasTexture with trilinear mipmaps (text stays crisp at distance and at grazing angles). */
export function createCanvasTexture(w: number, h: number, anisotropy = 1): CanvasTex {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[ui] 2D canvas context unavailable');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  return { canvas, ctx, texture };
}

export function font(weight: number | string, px: number, family: string, italic = false): string {
  return `${italic ? 'italic ' : ''}${weight} ${Math.round(px)}px ${family}`;
}

/** Letter spacing where supported (Chromium/Quest Browser); silently ignored elsewhere. */
export function setTracking(ctx: CanvasRenderingContext2D, px: number): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Greedy word wrap; very long words are kept whole (callers shrink the font to fit). */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

/** Largest font size (<= maxPx) at which `text` wraps into <= maxLines lines of <= maxWidth. */
export function fitWrapped(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number | string,
  family: string,
  maxPx: number,
  minPx: number,
  maxWidth: number,
  maxLines: number,
  italic = false,
): { px: number; lines: string[] } {
  for (let px = maxPx; px >= minPx; px -= 2) {
    ctx.font = font(weight, px, family, italic);
    const lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) return { px, lines };
  }
  ctx.font = font(weight, minPx, family, italic);
  return { px: minPx, lines: wrapLines(ctx, text, maxWidth) };
}

export function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number, points = 5, rot = -Math.PI / 2): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** A row of 5-point stars: `filled` gold stars then outlined empties. */
export function drawStars(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  filled: number,
  total: number,
  opts: { fill?: string; stroke?: string; empty?: string; gap?: number; lineWidth?: number } = {},
): void {
  const gap = opts.gap ?? r * 2.5;
  const x0 = cx - ((total - 1) * gap) / 2;
  for (let i = 0; i < total; i++) {
    starPath(ctx, x0 + i * gap, cy, r, r * 0.45);
    ctx.lineJoin = 'round';
    ctx.lineWidth = opts.lineWidth ?? Math.max(2, r * 0.14);
    if (i < filled) {
      ctx.fillStyle = opts.fill ?? '#ffcf5a';
      ctx.fill();
    } else if (opts.empty) {
      ctx.fillStyle = opts.empty;
      ctx.fill();
    }
    ctx.strokeStyle = opts.stroke ?? '#241a12';
    ctx.stroke();
  }
}

/** Metallic gold gradient (vertical) for borders and lettering. */
export function goldGradient(ctx: CanvasRenderingContext2D, y0: number, y1: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, '#fff1bf');
  g.addColorStop(0.35, '#ffd36a');
  g.addColorStop(0.55, '#c38a2c');
  g.addColorStop(0.8, '#f2c35c');
  g.addColorStop(1, '#a8741f');
  return g;
}

/** Fine speckle grain (paper, enamel). Deterministic per seed. */
export function grain(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, amount: number, seed: number, dark = true): void {
  const r = rng(seed);
  const n = Math.round(w * h * amount);
  ctx.save();
  for (let i = 0; i < n; i++) {
    const a = 0.03 + r() * 0.07;
    ctx.fillStyle = dark ? `rgba(40,25,10,${a.toFixed(3)})` : `rgba(255,248,230,${a.toFixed(3)})`;
    const s = 1 + r() * 1.6;
    ctx.fillRect(x + r() * w, y + r() * h, s, s);
  }
  ctx.restore();
}

/** Soft edge darkening (aged paper / vignette) inside a rect. */
export function vignette(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, strength: number): void {
  const g = ctx.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.35, x + w / 2, y + h / 2, Math.hypot(w, h) * 0.6);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, color);
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** Small diamond-and-dot flourish centred at (cx, cy), `w` wide. */
export function flourish(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, color: string, lw = 3): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  const d = w * 0.06;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy);
  ctx.lineTo(cx - d * 2.2, cy);
  ctx.moveTo(cx + d * 2.2, cy);
  ctx.lineTo(cx + w / 2, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - d);
  ctx.lineTo(cx + d, cy);
  ctx.lineTo(cx, cy + d);
  ctx.lineTo(cx - d, cy);
  ctx.closePath();
  ctx.fill();
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + s * (w / 2 + lw * 1.6), cy, lw * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Twisted-rope strip (diagonal bands) used for the hanging cords of signs and cards. */
export function ropeStrip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, stretch: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#7a5418');
  g.addColorStop(0.45, '#ffd978');
  g.addColorStop(1, '#6b4714');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // diagonal twist bands; `stretch` pre-compensates the strip being stretched along its length in 3D
  ctx.strokeStyle = 'rgba(60,35,8,0.55)';
  ctx.lineWidth = Math.max(2, h * 0.18);
  const step = h * 1.1 * stretch;
  for (let px = x - h * stretch; px < x + w + step; px += step) {
    ctx.beginPath();
    ctx.moveTo(px, y + h);
    ctx.lineTo(px + h * stretch, y);
    ctx.stroke();
  }
  ctx.restore();
}
