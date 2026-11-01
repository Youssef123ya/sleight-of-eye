// Procedural canvas textures for the café: one shared glow/particle atlas, the gingham cloth, the velvet close-up mat,
// the wallpaper, the décor atlas (chalkboard, clock, labels) and the pocket-watch dial. Built once at startup.
import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace } from '@iwsdk/core';
import { L } from '../layout.js';
import { FONT_DISPLAY } from '../ui/fonts.js';
import { rng } from './util.js';

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sst = (e0: number, e1: number, x: number) => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------------- glow atlas

/** Cells of the shared 8×2 mask atlas (R = coverage, G/R = shade). */
export const CELL = {
  halo: 0,
  star4: 1,
  ring: 2,
  flame: 3,
  pool: 4,
  note: 5,
  dot: 6,
  star5: 7,
  puff: 8,
  spark: 9,
  ringSoft: 10,
  star6: 11,
  blobRound: 12,
  blobRect: 13,
  diamond: 14,
  glitter: 15,
} as const;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 2;

function sdStar5(px: number, py: number, r: number, rf: number): number {
  const k1x = 0.809016994375;
  const k1y = -0.587785252292;
  const k2x = -k1x;
  const k2y = k1y;
  px = Math.abs(px);
  let d = Math.max(k1x * px + k1y * py, 0);
  px -= 2 * d * k1x;
  py -= 2 * d * k1y;
  d = Math.max(k2x * px + k2y * py, 0);
  px -= 2 * d * k2x;
  py -= 2 * d * k2y;
  px = Math.abs(px);
  py -= r;
  const bax = rf * -k1y - 0;
  const bay = rf * k1x - 1;
  const h = Math.min(Math.max((px * bax + py * bay) / (bax * bax + bay * bay), 0), r);
  const dx = px - bax * h;
  const dy = py - bay * h;
  return Math.hypot(dx, dy) * Math.sign(py * bax - px * bay);
}

type CellFn = (x: number, y: number, r: number) => [number, number]; // [coverage, shade]

const ray = (u: number, v: number, len: number, w0: number) => {
  const au = Math.abs(u) / len;
  if (au >= 1) return 0;
  const w = w0 * (1 - au) + 0.008;
  return Math.pow(1 - au, 1.6) * Math.exp(-(v * v) / (w * w));
};

const CELL_FNS: Record<number, CellFn> = {
  [CELL.halo]: (_x, _y, r) => [sat(Math.pow(Math.max(0, 1 - r), 2.3) * 0.8 + Math.exp(-r * r * 26) * 0.2), 1],
  [CELL.star4]: (x, y, r) => {
    const s2 = Math.SQRT1_2;
    const a =
      ray(x, y, 1, 0.05) +
      ray(y, x, 1, 0.05) +
      0.55 * ray((x + y) * s2, (x - y) * s2, 0.5, 0.035) +
      0.55 * ray((x - y) * s2, (x + y) * s2, 0.5, 0.035) +
      Math.exp(-r * r * 45) +
      0.3 * Math.exp(-r * r * 7);
    return [sat(a), 1];
  },
  [CELL.ring]: (_x, _y, r) => [sat(Math.exp(-(((r - 0.8) / 0.055) ** 2)) + 0.05 * (1 - sst(0.65, 0.8, r))) * (1 - sst(0.94, 1, r)), 1],
  [CELL.flame]: (x, y) => {
    // teardrop: round bottom circle at y=-0.35 r=0.42, tip at y=0.95
    let d: number;
    if (y < -0.35) d = Math.hypot(x, y + 0.35) - 0.42;
    else {
      const t = (y + 0.35) / 1.3;
      const w = 0.42 * Math.pow(Math.max(0, 1 - t), 0.85);
      d = Math.abs(x) - w;
    }
    const cov = sst(0.1, -0.06, d);
    const core = 0.5 + 0.5 * Math.exp(-((x / 0.22) ** 2 + ((y + 0.32) / 0.42) ** 2));
    return [sat(cov * core), 1];
  },
  [CELL.pool]: (_x, _y, r) => [sat(Math.pow(sst(1, 0, r), 1.35) * (0.86 + 0.14 * sst(0.55, 0, r))), 1],
  [CELL.note]: () => [0, 1], // drawn with paths below
  [CELL.dot]: (_x, _y, r) => [sat(Math.exp(-r * r * 10) * 0.85 + Math.exp(-r * r * 60) * 0.3), 1],
  [CELL.star5]: (x, y) => {
    const d = sdStar5(x, y + 0.04, 0.9, 0.48);
    const cov = sst(0.05, -0.03, d);
    const shade = 0.62 + 0.38 * sat(1 - Math.hypot(x + 0.15, y - 0.2) * 0.9);
    return [cov, shade];
  },
  [CELL.puff]: (x, y) => {
    const circles: Array<[number, number, number]> = [
      [-0.3, -0.18, 0.46],
      [0.27, -0.2, 0.44],
      [0, 0.18, 0.52],
      [-0.48, 0.12, 0.3],
      [0.47, 0.12, 0.32],
    ];
    let inv = 1;
    for (const [cx, cy, cr] of circles) {
      const d = Math.hypot(x - cx, y - cy) / cr;
      inv *= 1 - sst(1, 0.35, d);
    }
    const cov = 1 - inv;
    const shade = 0.72 + 0.28 * sat(0.55 + y * 0.6 - x * 0.25);
    return [sat(cov), shade];
  },
  [CELL.spark]: (x, y) => [sat(Math.exp(-((x / 0.95) ** 2 + (y / 0.2) ** 2) * 3) + 0.4 * Math.exp(-((x / 0.35) ** 2 + (y / 0.1) ** 2) * 3)), 1],
  [CELL.ringSoft]: (_x, _y, r) => [sat(Math.exp(-(((r - 0.7) / 0.14) ** 2))) * (1 - sst(0.9, 1, r)), 1],
  [CELL.star6]: (x, y, r) => {
    let a = Math.exp(-r * r * 40) + 0.25 * Math.exp(-r * r * 6);
    for (let k = 0; k < 3; k++) {
      const th = (k * Math.PI) / 3 + Math.PI / 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      a += 0.9 * ray(x * c + y * s, -x * s + y * c, 0.9, 0.045);
    }
    return [sat(a), 1];
  },
  [CELL.blobRound]: (_x, _y, r) => [sat(Math.pow(sst(1, 0, r), 1.5)), 1],
  [CELL.blobRect]: (x, y) => {
    const qx = Math.abs(x) - 0.5;
    const qy = Math.abs(y) - 0.5;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.12;
    return [sat(sst(0.36, -0.22, d)), 1];
  },
  [CELL.diamond]: (x, y) => {
    const d = Math.abs(x) + Math.abs(y) - 0.62;
    return [sat(Math.exp(-((d / 0.075) ** 2)) + 0.15 * Math.exp(-(x * x + y * y) * 30)), 1];
  },
  [CELL.glitter]: (x, y, r) => [sat(ray(x, y, 0.9, 0.06) + ray(y, x, 0.9, 0.06) + Math.exp(-r * r * 30)), 1],
};

export function makeGlowAtlas(): CanvasTexture {
  const S = 128;
  const [c, g] = canvas2d(S * ATLAS_COLS, S * ATLAS_ROWS);
  const img = g.createImageData(c.width, c.height);
  for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
    const fn = CELL_FNS[cell];
    if (!fn) continue;
    const ox = (cell % ATLAS_COLS) * S;
    const oy = Math.floor(cell / ATLAS_COLS) * S;
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const x = (px + 0.5) / (S / 2) - 1;
        const y = 1 - (py + 0.5) / (S / 2);
        const r = Math.hypot(x, y);
        let [a, s] = fn(x, y, r);
        // keep a clean 3 px border so mip levels do not bleed between cells
        if (px < 3 || py < 3 || px > S - 4 || py > S - 4) a = 0;
        const o = ((oy + py) * c.width + ox + px) * 4;
        img.data[o] = Math.round(a * 255);
        img.data[o + 1] = Math.round(a * s * 255);
        img.data[o + 2] = Math.round(a * 255);
        img.data[o + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  // music note ♪ drawn with paths (white)
  {
    const ox = (CELL.note % ATLAS_COLS) * S;
    const oy = Math.floor(CELL.note / ATLAS_COLS) * S;
    g.save();
    g.translate(ox + S / 2, oy + S / 2);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.ellipse(-14, 30, 20, 14, -0.45, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(3, 26);
    g.lineTo(3, -44);
    g.stroke();
    g.beginPath();
    g.moveTo(1, -46);
    g.bezierCurveTo(16, -36, 34, -26, 26, -2);
    g.bezierCurveTo(30, -20, 18, -26, 4, -28);
    g.closePath();
    g.fill();
    g.restore();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ----------------------------------------------------------------------------------------- gingham cloth

/** Cream/red gingham tile: 4×4 checks per tile (the cloth maps one tile to ~10 cm). */
export function makeClothTexture(anisotropy: number): CanvasTexture {
  const N = 256;
  const [c, g] = canvas2d(N, N);
  const img = g.createImageData(N, N);
  const rand = rng(7);
  const cream = [226, 212, 184];
  const red = [148, 54, 48];
  const check = N / 4;
  const jitter: number[] = [];
  for (let i = 0; i < 16; i++) jitter.push(1 + (rand() - 0.5) * 0.04);
  // signed distance (px) into a stripe: >0 inside, <0 outside; soft 3 px woven edge
  const stripe = (p: number) => {
    const q = (p + 0.5) % (check * 2);
    const d = q < check ? Math.min(q, check - q) : -Math.min(q - check, check * 2 - q);
    return sat(0.5 + d / 3);
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const vx = stripe(x);
      const vy = stripe(y);
      const amt = Math.min(0.86, vx * 0.38 + vy * 0.38 + vx * vy * 0.26);
      // weave: alternating thread rows/cols
      const weave = 1 + 0.035 * (((x >> 1) + (y >> 1)) % 2 === 0 ? 1 : -1) + (rand() - 0.5) * 0.05;
      const j = jitter[(Math.floor(x / check) % 4) + (Math.floor(y / check) % 4) * 4];
      const o = (y * N + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = (cream[ch] * (1 - amt) + red[ch] * amt) * weave * j;
        img.data[o + ch] = Math.max(0, Math.min(255, Math.round(v)));
      }
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// --------------------------------------------------------------------------------------- velvet mat

/** Mat-local (x right, z toward the player) → canvas pixel. */
function matPx(x: number, z: number, W: number, H: number): [number, number] {
  const [mw, md] = L.mat.size;
  return [((x + mw / 2) / mw) * W, ((z + md / 2) / md) * H];
}

function chalkCircle(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, rand: () => number, dashed = false) {
  for (let pass = 0; pass < 3; pass++) {
    g.beginPath();
    const steps = 64;
    const off = rand() * Math.PI * 2;
    for (let i = 0; i <= steps; i++) {
      const a = off + (i / steps) * Math.PI * 2 * (pass === 2 ? 0.92 : 1.0);
      const rr = r + Math.sin(a * 3 + pass) * 0.9 + (rand() - 0.5) * 0.9;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.setLineDash(dashed ? [10, 7] : []);
    g.lineWidth = pass === 0 ? 3.2 : 1.6;
    g.strokeStyle = `rgba(246, 240, 224, ${pass === 0 ? 0.55 : 0.32})`;
    g.stroke();
  }
  g.setLineDash([]);
}

export function makeMatTexture(anisotropy: number): CanvasTexture {
  const W = 768;
  const H = 512;
  const [c, g] = canvas2d(W, H);
  const rand = rng(21);
  // crushed-velvet base with soft mottling + fine nap
  const img = g.createImageData(W, H);
  const blobs: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 70; i++) blobs.push([rand() * W, rand() * H, 30 + rand() * 90, (rand() - 0.5) * 0.16]);
  const base = [36, 98, 64];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 1;
      for (let b = 0; b < blobs.length; b += 3) {
        const [bx, by, br, bv] = blobs[b];
        const d = ((x - bx) ** 2 + (y - by) ** 2) / (br * br);
        if (d < 1) m += bv * (1 - d) * (1 - d);
      }
      const nap = 1 + (rand() - 0.5) * 0.07;
      const o = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) img.data[o + ch] = Math.max(0, Math.min(255, Math.round(base[ch] * m * nap)));
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // gold double border + corner stars
  g.strokeStyle = 'rgba(214, 170, 82, 0.95)';
  g.lineWidth = 4;
  g.strokeRect(16, 16, W - 32, H - 32);
  g.lineWidth = 1.6;
  g.strokeStyle = 'rgba(214, 170, 82, 0.75)';
  g.strokeRect(25, 25, W - 50, H - 50);
  g.fillStyle = 'rgba(224, 182, 92, 0.95)';
  for (const [x, y] of [
    [25, 25],
    [W - 25, 25],
    [25, H - 25],
    [W - 25, H - 25],
  ]) {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 11 : 3.6;
      if (i === 0) g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
  }
  // chalk marks under prop homes (mat-local coordinates)
  const mc = L.mat.center;
  const local = (p: readonly number[]): [number, number] => matPx(p[0] - mc[0], p[2] - mc[2], W, H);
  const pxPerM = W / L.mat.size[0];
  for (const id of ['cupLeft', 'cupMid', 'cupRight'] as const) {
    const [x, y] = local(L.propMarks[id]);
    chalkCircle(g, x, y, 0.034 * pxPerM, rand);
  }
  {
    // small inner mark for coin / ball / watch (concentric-ish with the middle cup)
    const [x, y] = local(L.propMarks.coin);
    chalkCircle(g, x, y, 0.017 * pxPerM, rand, true);
  }
  {
    // cupcake box footprint: chalk square with rounded corners
    const [x, y] = local(L.propMarks.cupcake);
    const s = 0.035 * pxPerM;
    for (let pass = 0; pass < 2; pass++) {
      g.beginPath();
      g.setLineDash(pass === 0 ? [] : [12, 8]);
      g.lineWidth = pass === 0 ? 3 : 1.5;
      g.strokeStyle = `rgba(246, 240, 224, ${pass === 0 ? 0.5 : 0.3})`;
      g.roundRect(x - s + (rand() - 0.5) * 2, y - s + (rand() - 0.5) * 2, 2 * s, 2 * s, 9);
      g.stroke();
    }
    g.setLineDash([]);
  }
  {
    // the volunteer's spot: a tiny chalk star
    const [x, y] = local(L.volunteerSpot);
    g.strokeStyle = 'rgba(246, 240, 224, 0.42)';
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 13 : 5.5;
      if (i === 0) g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    g.stroke();
  }
  // chalk dust smudges
  for (let i = 0; i < 26; i++) {
    const x = 60 + rand() * (W - 120);
    const y = 60 + rand() * (H - 120);
    const grd = g.createRadialGradient(x, y, 0, x, y, 8 + rand() * 18);
    grd.addColorStop(0, 'rgba(240,236,220,0.07)');
    grd.addColorStop(1, 'rgba(240,236,220,0)');
    g.fillStyle = grd;
    g.fillRect(x - 30, y - 30, 60, 60);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------------------------------ wallpaper

/** Near-white repeating damask-stripe wallpaper; vertex colours give it its hue. Tile ≈ 0.24 m. */
export function makeWallpaperTexture(anisotropy: number): CanvasTexture {
  const N = 256;
  const [c, g] = canvas2d(N, N);
  const img = g.createImageData(N, N);
  const rand = rng(3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const bx = x % 128;
      let v = bx < 80 ? 1.0 : 0.94;
      if (Math.abs(bx - 80) < 2 || bx < 2) v = 0.86;
      if (Math.abs(bx - 104) < 1) v = 0.9;
      // small diamond motif in the middle of the wide band
      const mx = bx - 40;
      const my = (y % 128) - 64;
      const dd = Math.abs(mx) / 15 + Math.abs(my) / 26;
      if (dd < 1 && dd > 0.62) v *= 0.92;
      if (dd < 0.28) v *= 0.94;
      v *= 1 + (rand() - 0.5) * 0.03;
      const o = (y * N + x) * 4;
      const b = Math.round(Math.min(1, v) * 255);
      img.data[o] = b;
      img.data[o + 1] = b;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}
/** A UV that samples the plain (1.0) part of the wallpaper: used for floor, ceiling and wainscot. */
export const WALLPAPER_PLAIN_UV: readonly [number, number] = [0.16, 0.12];

// ---------------------------------------------------------------------------------------- décor atlas

/** Rects in the 1024² décor atlas as [u0, v0, u1, v1]. */
export const DECOR = {
  chalkboard: [0, 0.375, 0.5, 1] as const, // 512×640 px (top-left)
  clock: [0.5, 0.5, 1, 1] as const, // 512×512 (top-right)
  label0: [0.5, 0.375, 0.625, 0.5] as const,
  label1: [0.625, 0.375, 0.75, 0.5] as const,
  label2: [0.75, 0.375, 0.875, 0.5] as const,
  label3: [0.875, 0.375, 1, 0.5] as const,
  sign: [0, 0, 1, 0.375] as const, // 1024×384 café sign
};

export function makeDecorTexture(anisotropy: number): CanvasTexture {
  const N = 1024;
  const [c, g] = canvas2d(N, N);
  const rand = rng(11);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, N, N);
  const serif = FONT_DISPLAY; // self-hosted Playfair Display (ensureFonts runs before the café is built)

  // --- chalkboard (0,0)-(512,640)
  g.fillStyle = '#1b2420';
  g.fillRect(0, 0, 512, 640);
  for (let i = 0; i < 40; i++) {
    const x = rand() * 512;
    const y = rand() * 640;
    const grd = g.createRadialGradient(x, y, 0, x, y, 30 + rand() * 60);
    grd.addColorStop(0, 'rgba(210,220,210,0.045)');
    grd.addColorStop(1, 'rgba(210,220,210,0)');
    g.fillStyle = grd;
    g.fillRect(x - 90, y - 90, 180, 180);
  }
  const chalk = (txt: string, x: number, y: number, size: number, color = 'rgba(244,240,228,0.9)', italic = true) => {
    g.font = `${italic ? 'italic ' : ''}${size}px ${serif}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(txt, x, y);
    g.globalAlpha = 0.35;
    g.fillText(txt, x + 1.2, y + 0.8);
    g.globalAlpha = 1;
  };
  chalk('Midnight', 256, 78, 70);
  chalk('Café', 256, 150, 74);
  g.strokeStyle = 'rgba(244,240,228,0.6)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(120, 200);
  g.bezierCurveTo(200, 186, 312, 214, 392, 198);
  g.stroke();
  chalk('~ tonight ~', 256, 246, 34, 'rgba(255,214,140,0.9)');
  chalk('MAGIC', 256, 300, 48, 'rgba(255,224,150,0.95)', false);
  chalk('up close', 256, 346, 32, 'rgba(255,214,140,0.85)');
  const menu: Array<[string, string]> = [
    ['hot chocolate', '3'],
    ['apple tart', '4'],
    ['croissant', '2'],
  ];
  menu.forEach(([item, price], i) => {
    const y = 420 + i * 52;
    g.font = `italic 30px ${serif}`;
    g.textAlign = 'left';
    g.fillStyle = 'rgba(240,236,224,0.85)';
    g.fillText(item, 60, y);
    g.textAlign = 'right';
    g.fillText(price, 452, y);
    g.fillStyle = 'rgba(240,236,224,0.35)';
    for (let d = 300; d < 420; d += 12) g.fillRect(d, y + 6, 4, 3);
  });
  // doodles: top hat + wand, stars
  g.strokeStyle = 'rgba(244,240,228,0.8)';
  g.lineWidth = 3;
  g.strokeRect(62, 268, 52, 44);
  g.beginPath();
  g.moveTo(46, 312);
  g.lineTo(130, 312);
  g.stroke();
  g.beginPath();
  g.moveTo(128, 300);
  g.lineTo(168, 262);
  g.stroke();
  for (const [x, y, r] of [
    [176, 252, 10],
    [430, 280, 12],
    [396, 70, 9],
    [110, 74, 8],
  ] as const) {
    g.beginPath();
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.42;
      if (i === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.stroke();
  }

  // --- wall clock face (512,0)-(1024,512): reads midnight
  {
    const cx = 768;
    const cy = 256;
    const grd = g.createRadialGradient(cx - 60, cy - 80, 20, cx, cy, 250);
    grd.addColorStop(0, '#fbf3df');
    grd.addColorStop(1, '#e2d2ae');
    g.fillStyle = grd;
    g.fillRect(512, 0, 512, 512);
    g.strokeStyle = '#2a1d14';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(cx, cy, 236, 0, Math.PI * 2);
    g.stroke();
    const romans = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    g.fillStyle = '#2a1d14';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
      const r0 = i % 5 === 0 ? 206 : 214;
      g.lineWidth = i % 5 === 0 ? 6 : 2.5;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * 226, cy + Math.sin(a) * 226);
      g.stroke();
    }
    g.font = `bold 46px ${serif}`;
    romans.forEach((t, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      g.fillText(t, cx + Math.cos(a) * 168, cy + Math.sin(a) * 168);
    });
    g.font = `italic 26px ${serif}`;
    g.fillText('Midnight', cx, cy + 82);
    // hands at 11:59 (almost midnight)
    const hand = (ang: number, len: number, w: number) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(-w, 18);
      g.lineTo(-w * 0.6, -len * 0.75);
      g.lineTo(0, -len);
      g.lineTo(w * 0.6, -len * 0.75);
      g.lineTo(w, 18);
      g.closePath();
      g.fill();
      g.restore();
    };
    hand(-0.03, 120, 9);
    hand(-0.105, 190, 6);
    g.beginPath();
    g.arc(cx, cy, 13, 0, Math.PI * 2);
    g.fill();
  }

  // --- bottle labels (512,384)-(1024,512): four 128×128 labels
  const labelColors = ['#efe0bd', '#e9d6a6', '#f3e6cc', '#e3cfa0'];
  const stripe = ['#9b2a25', '#1f4d36', '#2c3c78', '#7a4a16'];
  for (let i = 0; i < 4; i++) {
    const x = 512 + i * 128;
    const y = 512;
    g.fillStyle = labelColors[i];
    g.fillRect(x, y, 128, 128);
    g.fillStyle = stripe[i];
    g.fillRect(x, y + 14, 128, 10);
    g.fillRect(x, y + 104, 128, 10);
    g.font = `italic bold 34px ${serif}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(['Rouge', 'Menthe', 'Cassis', 'Cognac'][i], x + 64, y + 64);
  }

  // --- café sign (0,640)-(1024,1024): warm gilt lettering on dark wood
  {
    const y0 = 640;
    g.fillStyle = '#2a170e';
    g.fillRect(0, y0, 1024, 384);
    g.strokeStyle = '#c99a3c';
    g.lineWidth = 10;
    g.strokeRect(22, y0 + 22, 980, 340);
    g.lineWidth = 3;
    g.strokeRect(42, y0 + 42, 940, 300);
    g.fillStyle = '#e6be62';
    g.font = `italic bold 128px ${serif}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('Midnight Café', 512, y0 + 170, 900);
    g.font = `34px ${serif}`;
    g.fillStyle = '#d9b263';
    g.fillText('— MAGIC & COCOA —', 512, y0 + 290);
  }

  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// ----------------------------------------------------------------------------------- pocket-watch dial

export function makeDialTexture(): CanvasTexture {
  const N = 256;
  const [c, g] = canvas2d(N, N);
  const cx = N / 2;
  const cy = N / 2;
  const serif = FONT_DISPLAY;
  const grd = g.createRadialGradient(cx - 30, cy - 40, 10, cx, cy, 128);
  grd.addColorStop(0, '#fffaf0');
  grd.addColorStop(1, '#eadfc6');
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  g.strokeStyle = '#3a2a1a';
  g.fillStyle = '#2a1d14';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const major = i % 5 === 0;
    g.lineWidth = major ? 3.2 : 1.2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (major ? 104 : 110), cy + Math.sin(a) * (major ? 104 : 110));
    g.lineTo(cx + Math.cos(a) * 118, cy + Math.sin(a) * 118);
    g.stroke();
  }
  g.font = `bold 22px ${serif}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'].forEach((t, i) => {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    g.save();
    g.translate(cx + Math.cos(a) * 86, cy + Math.sin(a) * 86);
    g.rotate(a + Math.PI / 2);
    g.fillText(t, 0, 0);
    g.restore();
  });
  g.font = `italic 13px ${serif}`;
  g.fillText('Brock & Sons', cx, cy + 40);
  // hour + minute hands at 10:10 (spade style), painted in
  const hand = (ang: number, len: number, w: number) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(-w * 0.5, 10);
    g.lineTo(-w * 0.35, -len * 0.62);
    g.quadraticCurveTo(-w * 1.6, -len * 0.78, 0, -len);
    g.quadraticCurveTo(w * 1.6, -len * 0.78, w * 0.35, -len * 0.62);
    g.lineTo(w * 0.5, 10);
    g.closePath();
    g.fill();
    g.restore();
  };
  hand((-50 / 360) * Math.PI * 2, 62, 7);
  hand((60 / 360) * Math.PI * 2, 92, 5);
  g.beginPath();
  g.arc(cx, cy, 6, 0, Math.PI * 2);
  g.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
