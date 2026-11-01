// Hanging signs on gold ropes: the act title card (drops in, holds ~2 s, lifts) and the "Hold it!" banner.
// Sign + ropes are one mesh with one canvas texture (the ropes sample a rope strip drawn below the art).
import { BufferGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry } from '@iwsdk/core';
import { mergeParts } from '../art/geometry.js';
import { clamp01, deferred, easeInBack, Spring, type Deferred } from './anim.js';
import {
  createCanvasTexture,
  fitWrapped,
  flourish,
  font,
  goldGradient,
  grain,
  roundRectPath,
  ropeStrip,
  setTracking,
  type CanvasTex,
} from './canvas.js';
import type { UICtx } from './context.js';
import { FONT_BODY, FONT_DISPLAY } from './fonts.js';

const STRIP = 28; // rope strip rows at the bottom of the canvas
const GAP = 8;

interface SignSpec {
  name: string;
  artW: number; // px (canvas)
  artH: number; // px (canvas)
  /** art is designed at (artW, artH) / drawScale and drawn scaled up for texel density */
  drawScale?: number;
  width: number; // m
  rest: [number, number, number]; // rig-local centre
  ropeX: number; // m from centre
  ropeLen: number;
  ropeW: number;
}

function signGeometry(spec: SignSpec, canvasH: number): BufferGeometry {
  const h = (spec.width * spec.artH) / spec.artW;
  const v0 = (STRIP + GAP) / canvasH;
  const sign = new PlaneGeometry(spec.width, h);
  const suv = sign.getAttribute('uv');
  for (let i = 0; i < suv.count; i++) suv.setY(i, v0 + suv.getY(i) * (1 - v0));
  const ropes = [-1, 1].map((s) => {
    const r = new PlaneGeometry(spec.ropeW, spec.ropeLen);
    const uv = r.getAttribute('uv');
    // rope length (plane v) runs along the strip (canvas u); its width across the strip rows
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      uv.setXY(i, v * 0.98 + 0.01, (0.1 + u * 0.8) * (STRIP / canvasH));
    }
    return { geometry: r, color: 0xffffff, position: [s * spec.ropeX, h / 2 + spec.ropeLen / 2 - 0.002, -0.0015] as [number, number, number] };
  });
  const geo = mergeParts([{ geometry: sign, color: 0xffffff }, ...ropes], { keepUv: true });
  sign.dispose();
  for (const r of ropes) r.geometry.dispose();
  return geo;
}

type Phase = 'hidden' | 'in' | 'hold' | 'out';

class HangingSign {
  readonly group = new Group();
  readonly ct: CanvasTex;
  private readonly mesh: Mesh;
  private readonly mat: MeshBasicMaterial;
  private phase: Phase = 'hidden';
  private readonly drop = new Spring(1, 140, 16);
  private swing = 0;
  private swingV = 0;
  private outT = 0;
  private time = 0;
  private flip = 1; // 1 = facing; dips to 0 while the banner swaps text
  private flipT = -1;
  private pendingDraw: (() => void) | null = null;
  onHidden: (() => void) | null = null;

  constructor(
    ctx: UICtx,
    private readonly spec: SignSpec,
  ) {
    const canvasH = spec.artH + GAP + STRIP;
    this.ct = createCanvasTexture(spec.artW, canvasH, Math.min(4, ctx.anisotropy));
    this.mat = new MeshBasicMaterial({ map: this.ct.texture, toneMapped: false });
    this.mat.name = spec.name;
    this.mesh = new Mesh(signGeometry(spec, canvasH), this.mat);
    this.mesh.name = `${spec.name}-mesh`;
    this.mesh.renderOrder = 6;
    this.group.name = spec.name;
    this.group.visible = false;
    this.group.add(this.mesh);
    this.group.position.set(...spec.rest);
    ctx.root.add(this.group);
    ropeStrip(this.ct.ctx, 0, spec.artH + GAP, spec.artW, STRIP, (spec.ropeW / spec.ropeLen) * (spec.artW / STRIP));
  }

  get shown(): boolean {
    return this.phase === 'in' || this.phase === 'hold';
  }

  /** Redraw the art (top artW × artH px) and drop the sign in (or flip it if already showing). */
  show(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
    const apply = () => {
      const c = this.ct.ctx;
      const k = this.spec.drawScale ?? 1;
      c.save();
      c.clearRect(0, 0, this.spec.artW, this.spec.artH + GAP);
      c.scale(k, k);
      draw(c, this.spec.artW / k, this.spec.artH / k);
      c.restore();
      this.ct.texture.needsUpdate = true;
    };
    if (this.phase === 'in' || this.phase === 'hold') {
      // already hanging: quick flip to swap the art
      this.pendingDraw = apply;
      this.flipT = 0;
      return;
    }
    apply();
    this.phase = 'in';
    this.drop.snap(1);
    this.swing = 0;
    this.swingV = 0.9;
    this.group.visible = true;
  }

  hide(): void {
    if (this.phase === 'hidden' || this.phase === 'out') return;
    this.phase = 'out';
    this.outT = 0;
  }

  update(dt: number): void {
    if (this.phase === 'hidden') return;
    this.time += dt;
    const [x, y, z] = this.spec.rest;
    let off: number;
    if (this.phase === 'out') {
      this.outT += dt;
      const u = clamp01(this.outT / 0.55);
      off = this.drop.x + easeInBack(u, 1.4) * 0.75;
      if (u >= 1) {
        this.phase = 'hidden';
        this.group.visible = false;
        this.onHidden?.();
        return;
      }
    } else {
      off = this.drop.step(0, dt);
      if (this.phase === 'in' && Math.abs(this.drop.x) < 0.002 && Math.abs(this.drop.v) < 0.02) this.phase = 'hold';
    }
    // pendulum swing, kicked by the drop, settling into an idle sway
    const acc = -55 * this.swing - 2.2 * this.swingV;
    this.swingV += acc * dt;
    this.swing += this.swingV * dt;
    const idle = 0.012 * Math.sin(this.time * 1.4);
    if (this.flipT >= 0) {
      this.flipT += dt;
      const u = clamp01(this.flipT / 0.32);
      if (u >= 0.5 && this.pendingDraw) {
        this.pendingDraw();
        this.pendingDraw = null;
      }
      this.flip = Math.abs(Math.cos(u * Math.PI));
      if (u >= 1) {
        this.flipT = -1;
        this.flip = 1;
      }
    }
    this.group.position.set(x, y + off * 0.75, z);
    this.group.rotation.set(0, 0, this.swing * 0.35 + idle * 0.5);
    this.mesh.scale.set(1, Math.max(0.02, this.flip), 1);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.ct.texture.dispose();
  }
}

// ------------------------------------------------------------------------------------------ title card
export class TitleCard {
  private readonly sign: HangingSign;
  private holdT = -1;
  private pending: Deferred | null = null;

  constructor(ctx: UICtx) {
    this.sign = new HangingSign(ctx, {
      name: 'ui-title-card',
      artW: 1280,
      artH: 720,
      width: 0.36,
      rest: [0, -0.07, -0.548],
      ropeX: 0.15,
      ropeLen: 0.9,
      ropeW: 0.0055,
    });
    this.sign.onHidden = () => {
      this.pending?.resolve();
      this.pending = null;
    };
  }

  show(title: string, subtitle?: string): Promise<void> {
    this.pending?.resolve();
    this.pending = deferred();
    this.sign.show((c, w, h) => drawTitleCard(c, w, h, title, subtitle));
    this.holdT = 0;
    return this.pending.promise;
  }

  update(dt: number): void {
    if (this.holdT >= 0 && this.sign.shown) {
      this.holdT += dt;
      if (this.holdT > 2.0 + 0.75) {
        this.holdT = -1;
        this.sign.hide();
      }
    }
    this.sign.update(dt);
  }

  dispose(): void {
    this.pending?.resolve();
    this.sign.dispose();
  }
}

function drawTitleCard(c: CanvasRenderingContext2D, w: number, h: number, title: string, subtitle?: string): void {
  // board
  const bg = c.createRadialGradient(w / 2, h * 0.45, 40, w / 2, h / 2, w * 0.62);
  bg.addColorStop(0, '#26306a');
  bg.addColorStop(0.65, '#141a40');
  bg.addColorStop(1, '#090c22');
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);
  grain(c, 0, 0, w, h, 0.012, 7, false);
  // gold frame: thick outer band, dark channel, fine inner rule
  c.lineJoin = 'round';
  c.strokeStyle = goldGradient(c, 0, h);
  c.lineWidth = 26;
  c.strokeRect(13, 13, w - 26, h - 26);
  c.strokeStyle = 'rgba(20,12,4,0.7)';
  c.lineWidth = 4;
  c.strokeRect(28, 28, w - 56, h - 56);
  c.strokeStyle = goldGradient(c, 0, h);
  c.lineWidth = 3;
  roundRectPath(c, 46, 46, w - 92, h - 92, 26);
  c.stroke();
  // corner fans
  c.fillStyle = goldGradient(c, 0, h);
  for (const [cx, cy, a] of [
    [46, 46, 0],
    [w - 46, 46, Math.PI / 2],
    [w - 46, h - 46, Math.PI],
    [46, h - 46, -Math.PI / 2],
  ] as Array<[number, number, number]>) {
    c.save();
    c.translate(cx, cy);
    c.rotate(a);
    for (let i = 0; i < 5; i++) {
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, 58 - i * 2, (i / 5) * (Math.PI / 2) + 0.06, ((i + 1) / 5) * (Math.PI / 2) - 0.06);
      c.closePath();
      c.globalAlpha = i % 2 ? 0.55 : 0.95;
      c.fill();
    }
    c.globalAlpha = 1;
    c.restore();
  }
  const label = subtitle && subtitle.length <= 12 ? subtitle : null;
  const below = subtitle && !label ? subtitle : null;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  let y = h * 0.5;
  if (label) {
    c.font = font(700, 54, FONT_DISPLAY);
    setTracking(c, 14);
    c.fillStyle = '#ffcf5a';
    c.fillText(`✦  ${label.toUpperCase()}  ✦`, w / 2, h * 0.27);
    setTracking(c, 0);
    y = h * 0.56;
  }
  const fit = fitWrapped(c, title, 700, FONT_DISPLAY, 132, 64, w - 220, 2);
  c.font = font(700, fit.px, FONT_DISPLAY);
  const lineH = fit.px * 1.05;
  const top = (below ? y - lineH * 0.35 : y) - ((fit.lines.length - 1) * lineH) / 2 + fit.px * 0.34;
  fit.lines.forEach((line, i) => {
    const ly = top + i * lineH;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillText(line, w / 2 + 3, ly + 5);
    c.fillStyle = goldGradient(c, ly - fit.px * 0.8, ly + fit.px * 0.1);
    c.fillText(line, w / 2, ly);
  });
  const after = top + (fit.lines.length - 1) * lineH;
  flourish(c, w / 2, after + 46, 340, '#c99a3c', 3);
  if (below) {
    const f2 = fitWrapped(c, below, 400, FONT_DISPLAY, 58, 34, w - 260, 1, true);
    c.font = font(400, f2.px, FONT_DISPLAY, true);
    c.fillStyle = '#fff4dc';
    c.fillText(f2.lines[0], w / 2, after + 46 + 74);
  }
}

// ---------------------------------------------------------------------------------------------- banner
export class Banner {
  private readonly sign: HangingSign;
  private text: string | null = null;

  constructor(ctx: UICtx) {
    this.sign = new HangingSign(ctx, {
      name: 'ui-banner',
      artW: 1536,
      artH: 480,
      drawScale: 1.5,
      width: 0.24,
      rest: [0, 0.032, -0.52],
      ropeX: 0.095,
      ropeLen: 0.75,
      ropeW: 0.0042,
    });
  }

  set(text: string | null): void {
    if (text === this.text) return;
    this.text = text;
    if (text === null) this.sign.hide();
    else this.sign.show((c, w, h) => drawBanner(c, w, h, text));
  }

  update(dt: number): void {
    this.sign.update(dt);
  }

  dispose(): void {
    this.sign.dispose();
  }
}

function drawBanner(c: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  // enamel sign with a red border and brass screws
  roundRectPath(c, 6, 6, w - 12, h - 12, 46);
  const bg = c.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#fffaf0');
  bg.addColorStop(1, '#efdcb4');
  c.fillStyle = bg;
  c.fill();
  c.lineWidth = 14;
  c.strokeStyle = '#a8322d';
  c.stroke();
  roundRectPath(c, 26, 26, w - 52, h - 52, 30);
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(201,154,60,0.9)';
  c.stroke();
  grain(c, 10, 10, w - 20, h - 20, 0.01, 3);
  for (const sx of [58, w - 58]) {
    c.beginPath();
    c.arc(sx, h / 2, 13, 0, Math.PI * 2);
    c.fillStyle = goldGradient(c, h / 2 - 13, h / 2 + 13);
    c.fill();
    c.strokeStyle = 'rgba(60,35,8,0.8)';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(sx - 7, h / 2 - 7);
    c.lineTo(sx + 7, h / 2 + 7);
    c.stroke();
  }
  // raised-palm icon ("hold it")
  const ix = 175;
  const iy = h / 2 + 4;
  c.save();
  c.translate(ix, iy);
  c.fillStyle = '#a8322d';
  roundRectPath(c, -34, -16, 68, 66, 26);
  c.fill();
  for (const [fx, fh] of [
    [-26, 52],
    [-9, 66],
    [8, 62],
    [25, 48],
  ] as Array<[number, number]>) {
    roundRectPath(c, fx - 7.5, -fh, 15, fh + 6, 7.5);
    c.fill();
  }
  c.save();
  c.translate(-36, 18);
  c.rotate(-0.7);
  roundRectPath(c, -8, -34, 16, 40, 8);
  c.fill();
  c.restore();
  c.restore();
  // lettering
  const maxW = w - 330;
  const fit = fitWrapped(c, text, 800, FONT_DISPLAY, 132, 54, maxW, 2, true);
  c.font = font(800, fit.px, FONT_DISPLAY, true);
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  const lineH = fit.px * 1.0;
  const cx = 230 + (w - 230 - 70) / 2;
  const y0 = h / 2 - ((fit.lines.length - 1) * lineH) / 2 + fit.px * 0.33;
  fit.lines.forEach((line, i) => {
    c.fillStyle = 'rgba(60,20,10,0.25)';
    c.fillText(line, cx + 3, y0 + i * lineH + 4);
    c.fillStyle = '#9b2a24';
    c.fillText(line, cx, y0 + i * lineH);
  });
  // tiny caption under one-line messages
  if (fit.lines.length === 1 && fit.px > 90) {
    c.font = font(700, 30, FONT_BODY);
    setTracking(c, 4);
    c.fillStyle = 'rgba(80,40,20,0.75)';
    c.fillText('THE AUDIENCE WAITS', cx, h - 44);
    setTracking(c, 0);
  }
}
