// Plaque face art (canvas): midnight-enamel faces with gold icons, and a lit "lamp" variant for toggles that
// are on (and for the press flash). Icons pair with labels and shapes, never colour alone.
import type { PlaqueAction } from '../contracts.js';
import { font, roundRectPath, setTracking } from './canvas.js';
import { FONT_BODY } from './fonts.js';

export const PLAQUE_LABEL: Record<PlaqueAction, string> = {
  retry: 'Retry',
  easy: 'Easy',
  assist: 'Assist',
  recenter: 'Recenter',
  exit: 'Exit',
};

export function isToggle(a: PlaqueAction): a is 'easy' | 'assist' {
  return a === 'easy' || a === 'assist';
}

/** Draw one face into the cell (x, y, w, h). `bleed` px of background are painted outside the cell. */
export function drawPlaqueFace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  action: PlaqueAction,
  lit: boolean,
  bleed = 6,
): void {
  ctx.save();
  // background (with bleed so mipmaps never pull in the gutter)
  const bg = ctx.createLinearGradient(0, y, 0, y + h);
  if (lit) {
    bg.addColorStop(0, '#ffe9a8');
    bg.addColorStop(0.55, '#ffc95a');
    bg.addColorStop(1, '#e79a2e');
  } else {
    bg.addColorStop(0, '#26306a');
    bg.addColorStop(0.6, '#161d48');
    bg.addColorStop(1, '#0e1331');
  }
  ctx.fillStyle = bg;
  ctx.fillRect(x - bleed, y - bleed, w + bleed * 2, h + bleed * 2);
  // inner glow / enamel sheen
  const glow = ctx.createRadialGradient(x + w / 2, y + h * 0.38, 4, x + w / 2, y + h * 0.38, w * 0.62);
  glow.addColorStop(0, lit ? 'rgba(255,255,235,0.75)' : 'rgba(120,140,255,0.16)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x, y, w, h);
  // top sheen band
  const sheen = ctx.createLinearGradient(0, y, 0, y + h * 0.35);
  sheen.addColorStop(0, lit ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.10)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h * 0.35);
  // pinstripe border + corner studs
  const ink = lit ? '#2a1b0e' : '#ffcf5a';
  const text = lit ? '#2a1b0e' : '#fff4dc';
  ctx.strokeStyle = lit ? 'rgba(80,45,10,0.75)' : 'rgba(201,154,60,0.95)';
  ctx.lineWidth = 3;
  roundRectPath(ctx, x + 12, y + 12, w - 24, h - 24, 14);
  ctx.stroke();
  ctx.fillStyle = lit ? 'rgba(80,45,10,0.8)' : '#c99a3c';
  for (const [sx, sy] of [
    [x + 12, y + 12],
    [x + w - 12, y + 12],
    [x + 12, y + h - 12],
    [x + w - 12, y + h - 12],
  ]) {
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  // icon
  ctx.save();
  ctx.translate(x + w / 2, y + h * 0.39);
  const s = (h * 0.42) / 100;
  ctx.scale(s, s);
  if (!lit) {
    ctx.shadowColor = 'rgba(255,190,90,0.55)';
    ctx.shadowBlur = 14 / s;
  }
  drawIcon(ctx, action, ink, lit ? '#ffe9a8' : '#1a2150');
  ctx.restore();
  // label
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = PLAQUE_LABEL[action];
  let px = 54;
  ctx.font = font(800, px, FONT_BODY);
  setTracking(ctx, 1);
  while (ctx.measureText(label).width > w - 56 && px > 30) {
    px -= 2;
    ctx.font = font(800, px, FONT_BODY);
  }
  ctx.fillText(label, x + w / 2, y + h * 0.86);
  setTracking(ctx, 0);
  // toggle pip: hollow ring = off, filled disc with a check = on
  if (isToggle(action)) {
    const px0 = x + w - 34;
    const py0 = y + 34;
    ctx.beginPath();
    ctx.arc(px0, py0, 13, 0, Math.PI * 2);
    if (lit) {
      ctx.fillStyle = '#2a1b0e';
      ctx.fill();
      ctx.strokeStyle = '#ffe9a8';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(px0 - 6, py0 + 0.5);
      ctx.lineTo(px0 - 1.5, py0 + 5.5);
      ctx.lineTo(px0 + 7, py0 - 5);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,244,220,0.75)';
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Icons in a 100×100 box centred on the origin. `bg` is used to punch details out of filled shapes. */
function drawIcon(ctx: CanvasRenderingContext2D, action: PlaqueAction, ink: string, bg: string): void {
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (action) {
    case 'retry': {
      const r = 32;
      const a0 = -Math.PI * 0.32;
      const a1 = a0 + Math.PI * 1.62;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.arc(0, 2, r, a0, a1);
      ctx.stroke();
      // arrowhead at the end of the sweep
      const ex = Math.cos(a1) * r;
      const ey = 2 + Math.sin(a1) * r;
      const tx = -Math.sin(a1);
      const ty = Math.cos(a1);
      const nx = Math.cos(a1);
      const ny = Math.sin(a1);
      ctx.beginPath();
      ctx.moveTo(ex + tx * 18, ey + ty * 18);
      ctx.lineTo(ex + nx * 16 - tx * 4, ey + ny * 16 - ty * 4);
      ctx.lineTo(ex - nx * 16 - tx * 4, ey - ny * 16 - ty * 4);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'easy': {
      // a sleepy, closed eye with lashes and drifting z's: "they're not watching so hard"
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(-6, -14, 36, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();
      ctx.lineWidth = 7;
      for (const a of [0.32, 0.5, 0.68]) {
        const t = Math.PI * a;
        const cx = -6 + Math.cos(t) * 36;
        const cy = -14 + Math.sin(t) * 36;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(t) * 13, cy + Math.sin(t) * 13);
        ctx.stroke();
      }
      ctx.font = `900 30px ${FONT_BODY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('z', 30, -26);
      ctx.font = `900 22px ${FONT_BODY}`;
      ctx.fillText('z', 44, -44);
      break;
    }
    case 'assist': {
      // the rabbit in the top hat (it does the reaching)
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(s * 12, -30);
        ctx.rotate(s * 0.22);
        ctx.beginPath();
        ctx.ellipse(0, -8, 9.5, 24, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.ellipse(0, -6, 4, 15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(-25, -12);
      ctx.lineTo(25, -12);
      ctx.lineTo(22, 28);
      ctx.lineTo(-22, 28);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = bg;
      ctx.fillRect(-23.5, 14, 47, 6.5); // hat band
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.ellipse(0, 30, 42, 8.5, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'recenter': {
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(0, 0, 27, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 8;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(c * 48, s * 48);
        ctx.lineTo(c * 36, s * 36);
        ctx.stroke();
        // inward chevrons
        ctx.beginPath();
        ctx.moveTo(c * 36 - s * 6, s * 36 + c * 6);
        ctx.lineTo(c * 31, s * 31);
        ctx.lineTo(c * 36 + s * 6, s * 36 - c * 6);
        ctx.stroke();
      }
      break;
    }
    case 'exit': {
      ctx.lineWidth = 8;
      ctx.strokeRect(-34, -38, 44, 76);
      ctx.beginPath(); // the door swinging open
      ctx.moveTo(-34, -38);
      ctx.lineTo(-12, -30);
      ctx.lineTo(-12, 44);
      ctx.lineTo(-34, 38);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(40, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(48, 0);
      ctx.lineTo(32, -13);
      ctx.lineTo(32, 13);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
}
