// Shared helpers for the gameplay-core stubs (G): glow texture, tiny tweens, canvas labels.
import { AdditiveBlending, CanvasTexture, SRGBColorSpace, Sprite, SpriteMaterial } from '@iwsdk/core';

let glow: CanvasTexture | null = null;

/** Soft round glow (cached). */
export function glowTexture(): CanvasTexture {
  if (glow) return glow;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  glow = new CanvasTexture(c);
  glow.colorSpace = SRGBColorSpace;
  return glow;
}

export function glowSprite(color: number, size: number, opacity = 1): Sprite {
  const s = new Sprite(
    new SpriteMaterial({
      map: glowTexture(),
      color,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity,
    }),
  );
  s.scale.setScalar(size);
  s.renderOrder = 10;
  return s;
}

interface Tween {
  t: number;
  d: number;
  step: (u: number) => void;
  done?: () => void;
}

/** Minimal tween list (allocation only when a tween starts). */
export class Tweens {
  private list: Tween[] = [];

  add(duration: number, step: (u: number) => void, done?: () => void): void {
    this.list.push({ t: 0, d: Math.max(1e-3, duration), step, done });
  }

  /** Promise-returning tween. */
  run(duration: number, step: (u: number) => void): Promise<void> {
    return new Promise((resolve) => this.add(duration, step, resolve));
  }

  clear(): void {
    for (const tw of this.list) tw.done?.();
    this.list.length = 0;
  }

  get busy(): boolean {
    return this.list.length > 0;
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tw = this.list[i];
      tw.t += dt;
      const u = tw.t >= tw.d ? 1 : tw.t / tw.d;
      try {
        tw.step(u);
      } catch {
        /* cosmetic */
      }
      if (u >= 1) {
        this.list.splice(i, 1);
        try {
          tw.done?.();
        } catch {
          /* cosmetic */
        }
      }
    }
  }
}

export type LabelStyle = 'speech' | 'shout' | 'whisper' | 'title' | 'banner' | 'plain';

/** A canvas-backed text sprite (re-drawn only when its text changes). */
export class Label {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly material: SpriteMaterial;
  readonly sprite: Sprite;
  private text = '';
  private style: LabelStyle = 'plain';

  constructor(
    w = 512,
    h = 128,
    readonly worldWidth = 0.22,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false });
    this.sprite = new Sprite(this.material);
    this.sprite.renderOrder = 50;
    this.sprite.scale.set(worldWidth, (worldWidth * h) / w, 1);
    this.sprite.visible = false;
  }

  draw(text: string, style: LabelStyle): void {
    if (text === this.text && style === this.style) return;
    this.text = text;
    this.style = style;
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = 14;
    let font = '600 54px Georgia, "Times New Roman", serif';
    let fill = '#241a12';
    let bg: string | null = 'rgba(255,244,220,0.96)';
    let stroke: string | null = '#241a12';
    if (style === 'shout') {
      font = '900 64px "Arial Black", Impact, sans-serif';
      fill = '#ffffff';
      bg = '#d8342b';
      stroke = '#ffd76a';
    } else if (style === 'whisper') {
      font = 'italic 48px Georgia, serif';
      fill = 'rgba(255,244,220,0.95)';
      bg = 'rgba(20,16,30,0.55)';
      stroke = null;
    } else if (style === 'title') {
      font = '700 76px Georgia, "Times New Roman", serif';
      fill = '#ffd76a';
      bg = null;
      stroke = null;
    } else if (style === 'banner') {
      font = '800 66px Georgia, serif';
      fill = '#fff4dc';
      bg = 'rgba(36,26,18,0.88)';
      stroke = '#ffcf5a';
    } else if (style === 'plain') {
      bg = null;
      stroke = null;
      fill = '#fff4dc';
    }
    ctx.font = font;
    // shrink to fit
    let size = parseInt(/(\d+)px/.exec(font)?.[1] ?? '54', 10);
    while (ctx.measureText(text).width > W - pad * 4 && size > 18) {
      size -= 4;
      font = font.replace(/\d+px/, `${size}px`);
      ctx.font = font;
    }
    const tw = Math.min(W - pad * 2, ctx.measureText(text).width + pad * 3);
    const x0 = (W - tw) / 2;
    if (bg) {
      ctx.fillStyle = bg;
      roundRect(ctx, x0, pad, tw, H - pad * 2 - (style === 'speech' ? 14 : 0), 26);
      ctx.fill();
      if (stroke) {
        ctx.lineWidth = 5;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
      if (style === 'speech') {
        // bubble tail
        ctx.beginPath();
        ctx.moveTo(W / 2 - 16, H - pad - 16);
        ctx.lineTo(W / 2, H - 4);
        ctx.lineTo(W / 2 + 16, H - pad - 16);
        ctx.closePath();
        ctx.fillStyle = bg;
        ctx.fill();
      }
    }
    ctx.fillStyle = fill;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (style === 'title') {
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 12;
    }
    ctx.fillText(text, W / 2, (H - (style === 'speech' ? 14 : 0)) / 2 + 2);
    ctx.shadowBlur = 0;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.sprite.removeFromParent();
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}
