// Speech-bubble captions: canvas text (≈4200 px/m, ≥2× display density at 0.7 m), yaw-billboarded toward the
// player, anchored above an Object3D. Styles: speech (cream bubble), shout (red jagged burst + jolt),
// whisper (dashed, italic, drifting). A pool of 4 bubbles; one draw call per visible bubble.
// Bubbles move every frame, so their matrices are written directly (xform.ts): no quaternion/Euler re-syncs.
import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3, type Object3D } from '@iwsdk/core';
import { clamp01, easeInCubic, easeOutBack } from './anim.js';
import { createCanvasTexture, fitWrapped, font, roundRectPath, type CanvasTex } from './canvas.js';
import type { UICtx } from './context.js';
import { FONT_BODY } from './fonts.js';
import { manualMatrix, planarPose, setPlanarPose, setYawPose } from './xform.js';

export type CaptionStyle = 'speech' | 'shout' | 'whisper';

const PX_PER_M = 4200;
const CW = 1024;
const CH = 512;
const POOL = 4;
const LIFT = 0.045; // metres above the anchor
const TOWARD_EYE = 0.018; // nudge toward the player so ears/hats never clip the bubble
const IN_T = 0.28;
const OUT_T = 0.2;
const DEG = Math.PI / 180;

interface Slot {
  ct: CanvasTex;
  mat: MeshBasicMaterial;
  group: Group;
  mesh: Mesh;
  target: Object3D | null;
  style: CaptionStyle;
  age: number;
  hold: number;
  out: number; // <0: not leaving; else seconds into the exit
  w: number;
  h: number;
  seed: number;
  active: boolean;
  born: number;
  /** bubble base in rig space (above the anchor, nudged toward the eye): kept for blocks() */
  readonly base: Vector3;
}

const tmp = new Vector3();
const face = new Vector3(0, 0, 1); // unit horizontal direction a bubble faces (toward the eye)
const pose = planarPose();

export class Captions {
  private readonly slots: Slot[] = [];
  private readonly geo: PlaneGeometry;
  private serial = 0;

  constructor(private readonly ctx: UICtx) {
    this.geo = new PlaneGeometry(1, 1);
    this.geo.translate(0, 0.5, 0); // pivot = tail tip at the bottom centre
    for (let i = 0; i < POOL; i++) {
      const ct = createCanvasTexture(CW, CH, Math.min(4, ctx.anisotropy));
      const mat = new MeshBasicMaterial({
        map: ct.texture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      });
      mat.name = `ui-caption-${i}`;
      const mesh = new Mesh(this.geo, mat);
      mesh.name = `ui-caption-${i}`;
      mesh.renderOrder = 30;
      manualMatrix(mesh);
      setPose(mesh, 0, 1e-4, 1e-4, 0, 0); // collapsed until a caption sizes it
      const group = new Group();
      group.name = `ui-caption-slot-${i}`;
      group.visible = false;
      manualMatrix(group);
      group.add(mesh);
      ctx.root.add(group);
      this.slots.push({
        ct, mat, group, mesh, target: null, style: 'speech', age: 0, hold: 2, out: -1, w: 0.1, h: 0.05, seed: i, active: false, born: 0,
        base: new Vector3(),
      });
    }
  }

  show(text: string, at: Object3D, opts: { seconds?: number; style?: CaptionStyle } = {}): void {
    const style = opts.style ?? 'speech';
    let slot = this.slots.find((s) => s.active && s.target === at);
    if (!slot) slot = this.slots.find((s) => !s.active);
    if (!slot) slot = this.slots.reduce((a, b) => (a.born <= b.born ? a : b));
    const { w, h } = drawBubble(slot.ct, text, style, this.serial);
    slot.ct.texture.repeat.set(w / CW, h / CH);
    slot.ct.texture.offset.set(0, 1 - h / CH);
    slot.ct.texture.needsUpdate = true;
    slot.w = w / PX_PER_M;
    slot.h = h / PX_PER_M;
    slot.target = at;
    slot.style = style;
    slot.age = 0;
    slot.out = -1;
    const auto = style === 'shout' ? 1.8 : 1.4 + text.length * 0.055;
    slot.hold = Math.max(0.6, opts.seconds ?? Math.min(5, auto));
    slot.seed = (this.serial * 7.31) % 6.28;
    slot.active = true;
    slot.born = ++this.serial;
    slot.group.visible = true;
    setPose(slot.mesh, 0, slot.w * 0.2, slot.h * 0.2, 0, 0); // the pop-in starts at 20 %
    this.place(slot);
  }

  /**
   * True while a bubble that is not on its way out sits within `marginDeg` of rig-local point `p` as seen from
   * the eye (bubble angular radius included). Hints ask this to stay out of a caption's way. Allocation-free.
   */
  blocks(p: Vector3, marginDeg = 8): boolean {
    const eye = this.ctx.eye;
    const px = p.x - eye.x;
    const py = p.y - eye.y;
    const pz = p.z - eye.z;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if (pl < 1e-4) return false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active || s.out >= 0) continue;
      const g = s.base;
      const cx = g.x - eye.x;
      const cy = g.y + s.h * 0.5 - eye.y; // bubble centre: the pivot is the tail tip at the bottom
      const cz = g.z - eye.z;
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (cl < 1e-4) continue;
      const cos = (px * cx + py * cy + pz * cz) / (pl * cl);
      const sep = Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos);
      const radius = Math.atan((0.5 * (s.w > s.h ? s.w : s.h)) / cl);
      if (sep < radius + marginDeg * DEG) return true;
    }
    return false;
  }

  clear(): void {
    for (const s of this.slots) if (s.active && s.out < 0) s.out = 0;
  }

  update(dt: number, time: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      s.age += dt;
      if (s.out < 0 && s.age >= IN_T + s.hold) s.out = 0;
      let scale: number;
      let alpha: number;
      if (s.out >= 0) {
        s.out += dt;
        const u = clamp01(s.out / OUT_T);
        scale = 1 - 0.4 * easeInCubic(u);
        alpha = 1 - u;
        if (u >= 1) {
          s.active = false;
          s.group.visible = false;
          s.target = null;
          continue;
        }
      } else {
        const u = clamp01(s.age / IN_T);
        scale = 0.2 + 0.8 * easeOutBack(u, 2.2);
        alpha = clamp01(s.age / 0.1);
      }
      this.place(s);
      let sx = scale;
      let sy = scale;
      let ox = 0;
      let oy = 0;
      let rz = 0;
      if (s.style === 'shout') {
        // the jolt: a punchy scale kick and a fast decaying shake
        const k = Math.exp(-s.age * 7.5);
        const punch = 1 + 0.32 * Math.exp(-s.age * 9);
        sx *= punch;
        sy *= punch;
        rz = 0.16 * Math.sin(s.age * 58) * k + 0.012 * Math.sin(time * 31 + s.seed);
        ox = 0.005 * Math.sin(s.age * 71) * k;
      } else if (s.style === 'whisper') {
        oy = 0.003 * Math.sin(time * 2.2 + s.seed);
        rz = 0.025 * Math.sin(time * 1.3 + s.seed);
      } else {
        oy = 0.0015 * Math.sin(time * 3.1 + s.seed);
      }
      pose.angle = rz;
      pose.sx = s.w * sx;
      pose.sy = s.h * sy;
      pose.x = ox;
      pose.y = oy;
      pose.z = 0;
      setPlanarPose(s.mesh, pose);
      s.mat.opacity = alpha;
    }
  }

  /** Position above the anchor and turn (yaw only) to face the player. Allocation-free (per frame). */
  private place(s: Slot): void {
    if (!s.target) return;
    // the anchor's world matrix as the renderer left it (≤ 1 frame stale): no recomposition of the entity chain
    this.ctx.frame.objectLocal(s.target, tmp);
    if (!Number.isFinite(tmp.x + tmp.y + tmp.z)) return; // keep the last pose
    const eye = this.ctx.eye;
    const dx = eye.x - tmp.x;
    const dz = eye.z - tmp.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    // face the eye (yaw only): local +Z → (dx, 0, dz) / d
    face.x = d > 1e-6 ? dx / d : 0;
    face.z = d > 1e-6 ? dz / d : 1;
    const b = s.base;
    b.x = tmp.x + face.x * TOWARD_EYE;
    b.y = tmp.y + LIFT;
    b.z = tmp.z + face.z * TOWARD_EYE;
    setYawPose(s.group, face, b);
  }

  dispose(): void {
    for (const s of this.slots) {
      s.group.removeFromParent();
      s.mat.dispose();
      s.ct.texture.dispose();
    }
    this.geo.dispose();
  }
}

/** Event-time convenience (show / construction): the per-frame path fills the shared pose itself. */
function setPose(mesh: Mesh, angle: number, sx: number, sy: number, x: number, y: number): void {
  pose.angle = angle;
  pose.sx = sx;
  pose.sy = sy;
  pose.x = x;
  pose.y = y;
  pose.z = 0;
  setPlanarPose(mesh, pose);
}

// ------------------------------------------------------------------------------------------ bubble art
interface Layout {
  lines: string[];
  px: number;
  textW: number;
  lineH: number;
  capH: number;
}

function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  px: number,
  maxW: number,
  italic: boolean,
  maxLines = 3,
): Layout {
  const fit = fitWrapped(ctx, text, weight, FONT_BODY, px, Math.round(px * 0.6), maxW, maxLines, italic);
  ctx.font = font(weight, fit.px, FONT_BODY, italic);
  let textW = 0;
  for (const l of fit.lines) textW = Math.max(textW, ctx.measureText(l).width);
  const capH = ctx.measureText('H').actualBoundingBoxAscent || fit.px * 0.7;
  return { lines: fit.lines, px: fit.px, textW, lineH: fit.px * 1.12, capH };
}

function drawLines(ctx: CanvasRenderingContext2D, lay: Layout, cx: number, cy: number, stroke?: { color: string; width: number }): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const n = lay.lines.length;
  for (let i = 0; i < n; i++) {
    const y = cy + (i - (n - 1) / 2) * lay.lineH + lay.capH / 2;
    if (stroke) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.strokeText(lay.lines[i], cx, y);
      ctx.restore();
    }
    ctx.fillText(lay.lines[i], cx, y);
  }
}

/** Draw a bubble into the top-left of the canvas; returns the used region in px (tail tip at bottom centre). */
function drawBubble(ct: CanvasTex, text: string, style: CaptionStyle, serial: number): { w: number; h: number } {
  const ctx = ct.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  if (style === 'shout') return drawShout(ctx, text, serial);
  if (style === 'whisper') return drawWhisper(ctx, text);
  return drawSpeech(ctx, text);
}

function drawSpeech(ctx: CanvasRenderingContext2D, text: string): { w: number; h: number } {
  const lay = layoutText(ctx, text, 800, 84, 600, false);
  const padX = 44;
  const padY = 30;
  const margin = 20;
  const tailH = 54;
  const bw = Math.min(CW - margin * 2, Math.max(lay.textW + padX * 2, 150));
  const bh = lay.lineH * (lay.lines.length - 1) + lay.capH + padY * 2 + 6;
  const w = Math.ceil(bw + margin * 2);
  const h = Math.ceil(bh + tailH + margin * 2);
  const x = margin;
  const y = margin;
  const cx = w / 2;
  const r = Math.min(46, bh / 2);
  const bottom = y + bh;
  // body + tail as one outline
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + bw - r, y);
    ctx.arcTo(x + bw, y, x + bw, y + r, r);
    ctx.lineTo(x + bw, bottom - r);
    ctx.arcTo(x + bw, bottom, x + bw - r, bottom, r);
    ctx.lineTo(cx + 22, bottom);
    ctx.quadraticCurveTo(cx + 8, bottom + tailH * 0.45, cx, h - margin + 6);
    ctx.quadraticCurveTo(cx - 6, bottom + tailH * 0.35, cx - 26, bottom);
    ctx.lineTo(x + r, bottom);
    ctx.arcTo(x, bottom, x, bottom - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  };
  ctx.save();
  ctx.shadowColor = 'rgba(20,10,0,0.38)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  path();
  const g = ctx.createLinearGradient(0, y, 0, bottom);
  g.addColorStop(0, '#fffbf2');
  g.addColorStop(1, '#f4e2c0');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  path();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#2a1d14';
  ctx.stroke();
  // soft highlight along the top edge
  ctx.save();
  roundRectPath(ctx, x + 10, y + 8, bw - 20, Math.min(26, bh * 0.3), 14);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#241a12';
  ctx.font = font(800, lay.px, FONT_BODY);
  drawLines(ctx, lay, cx, y + bh / 2);
  return { w, h };
}

function drawShout(ctx: CanvasRenderingContext2D, text: string, serial: number): { w: number; h: number } {
  const lay = layoutText(ctx, text, 900, 96, 700, false, 2);
  const margin = 18;
  const tailH = 58;
  const a = lay.textW / 2 + 70; // squircle half-size around the text
  const b = (lay.lineH * (lay.lines.length - 1) + lay.capH) / 2 + 52;
  const spike = 26;
  const w = Math.ceil(Math.min(CW, (a + spike) * 2 + margin * 2));
  const h = Math.ceil(Math.min(CH, (b + spike) * 2 + tailH + margin * 2));
  const cx = w / 2;
  const cy = margin + spike + b;
  const n = Math.max(16, Math.round((a + b) / 26));
  let s = (serial * 9301 + 49297) % 233280;
  const rand = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const pts: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const t = (i / (n * 2)) * Math.PI * 2;
    const c = Math.cos(t);
    const si = Math.sin(t);
    const ex = Math.sign(c) * Math.pow(Math.abs(c), 0.5) * a; // squircle (n = 4)
    const ey = Math.sign(si) * Math.pow(Math.abs(si), 0.5) * b;
    const len = Math.hypot(ex, ey) || 1;
    const out = i % 2 === 0 ? spike * (0.75 + rand() * 0.6) : -4;
    pts.push(cx + ex + (ex / len) * out, cy + ey + (ey / len) * out);
  }
  const bodyPath = () => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) ctx.moveTo(pts[i], pts[i + 1]);
      else ctx.lineTo(pts[i], pts[i + 1]);
    }
    ctx.closePath();
  };
  const tailPath = () => {
    ctx.beginPath();
    ctx.moveTo(cx - 34, cy + b - 6);
    ctx.lineTo(cx + 2, h - margin + 4);
    ctx.lineTo(cx + 20, cy + b - 10);
    ctx.closePath();
  };
  // outer ink keyline, then the red outline, then the fill
  ctx.save();
  ctx.lineJoin = 'miter';
  ctx.shadowColor = 'rgba(40,0,0,0.45)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#241a12';
  bodyPath();
  ctx.fill();
  tailPath();
  ctx.fill();
  ctx.restore();
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 6;
  ctx.lineWidth = 16;
  ctx.strokeStyle = '#241a12';
  bodyPath();
  ctx.stroke();
  tailPath();
  ctx.stroke();
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#d42a1e';
  bodyPath();
  ctx.stroke();
  tailPath();
  ctx.stroke();
  const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(a, b) * 1.1);
  g.addColorStop(0, '#fffbe0');
  g.addColorStop(0.6, '#ffe58a');
  g.addColorStop(1, '#ffc24a');
  ctx.fillStyle = g;
  bodyPath();
  ctx.fill();
  tailPath();
  ctx.fill();
  // speed lines inside the burst edge
  ctx.save();
  bodyPath();
  ctx.clip();
  ctx.strokeStyle = 'rgba(212,42,30,0.22)';
  ctx.lineWidth = 5;
  for (let i = 0; i < 14; i++) {
    const t = (i / 14) * Math.PI * 2 + 0.2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(t) * a * 0.92, cy + Math.sin(t) * b * 0.92);
    ctx.lineTo(cx + Math.cos(t) * (a + spike), cy + Math.sin(t) * (b + spike));
    ctx.stroke();
  }
  ctx.restore();
  // lettering: red with an ink keyline, slight tilt for energy
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.045);
  ctx.font = font(900, lay.px, FONT_BODY);
  ctx.fillStyle = '#d42a1e';
  drawLines(ctx, lay, 0, 0, { color: '#241a12', width: Math.max(6, lay.px * 0.09) });
  ctx.restore();
  return { w, h };
}

function drawWhisper(ctx: CanvasRenderingContext2D, text: string): { w: number; h: number } {
  const lay = layoutText(ctx, text, 600, 76, 560, true);
  const padX = 44;
  const padY = 28;
  const margin = 18;
  const tailH = 60;
  const bw = Math.min(CW - margin * 2, Math.max(lay.textW + padX * 2, 140));
  const bh = lay.lineH * (lay.lines.length - 1) + lay.capH + padY * 2 + 6;
  const w = Math.ceil(bw + margin * 2);
  const h = Math.ceil(bh + tailH + margin * 2);
  const x = margin;
  const y = margin;
  const cx = w / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(20,10,0,0.22)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  roundRectPath(ctx, x, y, bw, bh, Math.min(60, bh / 2));
  ctx.fillStyle = 'rgba(255,251,242,0.9)';
  ctx.fill();
  ctx.restore();
  roundRectPath(ctx, x, y, bw, bh, Math.min(60, bh / 2));
  ctx.setLineDash([14, 11]);
  ctx.lineCap = 'round';
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = '#6d5b4b';
  ctx.stroke();
  ctx.setLineDash([]);
  // trailing "hush" dots instead of a tail
  const dots: Array<[number, number, number]> = [
    [cx + 6, y + bh + 16, 11],
    [cx - 2, y + bh + 36, 7.5],
    [cx, h - margin - 2, 4.5],
  ];
  for (const [dx, dy, r] of dots) {
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,251,242,0.92)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#6d5b4b';
    ctx.stroke();
  }
  ctx.fillStyle = '#4a3a2e';
  ctx.font = font(600, lay.px, FONT_BODY, true);
  drawLines(ctx, lay, cx, y + bh / 2);
  return { w, h };
}
