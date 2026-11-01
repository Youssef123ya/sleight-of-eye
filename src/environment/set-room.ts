// The dim café around the table: wallpapered walls with wainscot, chequered floor, beamed ceiling, the night
// window (shader pane, drapes, sill still-life), chalkboard menu, midnight clock, gilt sign, fairy-light garland,
// a wall sconce + picture light, bottle shelves, a bar with an espresso machine and two bistro tables with their
// chairs upturned for the night. Everything lands in the material buckets (merged later).
import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from '@iwsdk/core';
import { mergeParts } from '../art/geometry.js';
import { PAL } from '../art/palette.js';
import { MODE } from './glow.js';
import { CELL, DECOR, WALLPAPER_PLAIN_UV } from './textures.js';
import {
  BACK,
  CEIL,
  DADO,
  FLOOR,
  FRONT,
  LEFT,
  PICTURE_LIGHT,
  RIGHT,
  SCONCE,
  WIN,
  put,
  type Buckets,
  type StaticBlob,
  type StaticGlow,
} from './set-common.js';
import { atlasQuad, constUv, lathe, rng, roundedBox, TAU } from './util.js';

const TILE = 0.24; // wallpaper repeat (m)
const DOOR = { x: 0.95 };
const DOOR_GLASS = { w: 0.5, h: 0.62, y: 1.42 }; // centre height above the floor
const WALL = 0x5a7a92; // wallpaper tint (multiplied by baked light)
const WAINSCOT = 0x4a2c1a;
const PANEL = 0x5c3822;
const RAIL = 0x6a4428;
const CREAM_PAINT = 0xd6cbb2;

function worldUv(g: BufferGeometry, axes: 'xy' | 'zy' | 'xz'): BufferGeometry {
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    if (axes === 'xy') uv.setXY(i, x / TILE, y / TILE);
    else if (axes === 'zy') uv.setXY(i, z / TILE, y / TILE);
    else uv.setXY(i, x / TILE, z / TILE);
  }
  return g;
}

/** Plane in XY at depth z (facing +Z or −Z), subdivided for baked light. */
function planeXY(x0: number, x1: number, y0: number, y1: number, z: number, facing = 1, cell = 0.1): BufferGeometry {
  const g = new PlaneGeometry(x1 - x0, y1 - y0, Math.max(1, Math.round((x1 - x0) / cell)), Math.max(1, Math.round((y1 - y0) / cell)));
  if (facing < 0) g.rotateY(Math.PI);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return worldUv(g, 'xy');
}
/** Plane in ZY at x (facing +X or −X). */
function planeZY(z0: number, z1: number, y0: number, y1: number, x: number, facing = 1, cell = 0.1): BufferGeometry {
  const g = new PlaneGeometry(z1 - z0, y1 - y0, Math.max(1, Math.round((z1 - z0) / cell)), Math.max(1, Math.round((y1 - y0) / cell)));
  g.rotateY(facing > 0 ? Math.PI / 2 : -Math.PI / 2);
  g.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
  return worldUv(g, 'zy');
}
/** Plane in XZ at height y (facing up or down). */
function planeXZ(x0: number, x1: number, z0: number, z1: number, y: number, facing = 1, cell = 0.15): BufferGeometry {
  const g = new PlaneGeometry(x1 - x0, z1 - z0, Math.max(1, Math.round((x1 - x0) / cell)), Math.max(1, Math.round((z1 - z0) / cell)));
  g.rotateX(facing > 0 ? -Math.PI / 2 : Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return worldUv(g, 'xz');
}
const plain = <G extends BufferGeometry>(g: G): G => constUv(g, WALLPAPER_PLAIN_UV[0], WALLPAPER_PLAIN_UV[1]);

/** A bottle silhouette (lathe) of height h, body radius r. */
function bottle(h: number, r: number, style: number): BufferGeometry {
  const neck = r * (style === 2 ? 0.42 : 0.3);
  const sh = style === 1 ? 0.55 : 0.68;
  return lathe(
    [
      [0.001, 0],
      [r * 0.92, 0],
      [r, h * 0.04],
      [r, h * sh],
      [r * 0.82, h * (sh + 0.08)],
      [neck * 1.1, h * (sh + 0.17)],
      [neck, h * 0.9],
      [neck * 1.25, h * 0.93],
      [neck * 1.2, h],
      [0.001, h],
    ],
    14,
  );
}

export interface RoomResult {
  blobs: StaticBlob[];
  glows: Array<Omit<StaticGlow, 'slot'>>;
  windowPane: Mesh<BufferGeometry, ShaderMaterial>;
}

export function buildRoom(b: Buckets): RoomResult {
  const blobs: StaticBlob[] = [];
  const glows: Array<Omit<StaticGlow, 'slot'>> = [];
  const rand = rng(1234);

  // ------------------------------------------------------------------ shell: walls with a window opening
  put(b.room, planeXY(LEFT, WIN.x0, FLOOR, CEIL, BACK), WALL);
  put(b.room, planeXY(WIN.x1, RIGHT, FLOOR, CEIL, BACK), WALL);
  put(b.room, planeXY(WIN.x0, WIN.x1, FLOOR, WIN.y0, BACK), WALL);
  put(b.room, planeXY(WIN.x0, WIN.x1, WIN.y1, CEIL, BACK), WALL);
  // window reveal (tunnel to the recessed pane)
  const zr0 = BACK - WIN.depth;
  put(b.room, plain(planeZY(zr0, BACK, WIN.y0, WIN.y1, WIN.x0, 1, 0.06)), 0x5f6f86);
  put(b.room, plain(planeZY(zr0, BACK, WIN.y0, WIN.y1, WIN.x1, -1, 0.06)), 0x5f6f86);
  put(b.room, plain(planeXZ(WIN.x0, WIN.x1, zr0, BACK, WIN.y1, -1, 0.06)), 0x5f6f86);
  put(b.room, planeZY(-1.62, FRONT, FLOOR, CEIL, LEFT, 1), WALL);
  put(b.room, planeZY(-1.62, FRONT, FLOOR, CEIL, RIGHT, -1), WALL);
  put(b.room, planeXY(LEFT, RIGHT, FLOOR, CEIL, FRONT, -1), WALL);
  // ceiling + beams
  put(b.room, plain(planeXZ(LEFT, RIGHT, -1.62, FRONT, CEIL, -1, 0.2)), 0x6a5a6e);
  for (const z of [-1.15, -0.35, 0.45, 1.25]) put(b.wood, new BoxGeometry(RIGHT - LEFT, 0.12, 0.13), 0x3a2416, [0, CEIL - 0.06, z]);
  // chequered floor (0.3 m tiles)
  {
    const S = 0.3;
    for (let ix = 0; ix < Math.ceil((RIGHT - LEFT) / S); ix++) {
      for (let iz = 0; iz < Math.ceil((FRONT - BACK) / S); iz++) {
        const x0 = LEFT + ix * S;
        const z0 = BACK + iz * S;
        const x1 = Math.min(RIGHT, x0 + S);
        const z1 = Math.min(FRONT, z0 + S);
        const tile = plain(planeXZ(x0, x1, z0, z1, FLOOR, 1, S));
        put(b.room, tile, (ix + iz) % 2 === 0 ? 0xb4aa98 : 0x4a3c48);
      }
    }
  }

  // ------------------------------------------------------------------ wainscot, rails, baseboards
  const wainH = DADO - FLOOR;
  const backSpans: Array<[number, number]> = [
    [LEFT, RIGHT],
  ];
  for (const [x0, x1] of backSpans) {
    put(b.wood, new BoxGeometry(x1 - x0, wainH, 0.014), WAINSCOT, [(x0 + x1) / 2, FLOOR + wainH / 2, BACK + 0.007]);
    put(b.wood, roundedBox(x1 - x0, 0.034, 0.034, 0.006), RAIL, [(x0 + x1) / 2, DADO, BACK + 0.017]);
    put(b.wood, new BoxGeometry(x1 - x0, 0.1, 0.024), 0x2e1a10, [(x0 + x1) / 2, FLOOR + 0.05, BACK + 0.012]);
    for (let x = x0 + 0.35; x < x1 - 0.2; x += 0.62) {
      put(b.wood, roundedBox(0.5, wainH - 0.26, 0.012, 0.004), PANEL, [x + 0.16, FLOOR + wainH / 2 + 0.03, BACK + 0.016]);
    }
  }
  for (const side of [-1, 1]) {
    const x = side < 0 ? LEFT : RIGHT;
    put(b.wood, new BoxGeometry(0.014, wainH, FRONT + 1.62), WAINSCOT, [x - side * 0.007, FLOOR + wainH / 2, (FRONT - 1.62) / 2]);
    put(b.wood, roundedBox(0.034, 0.034, FRONT + 1.62, 0.006), RAIL, [x - side * 0.017, DADO, (FRONT - 1.62) / 2]);
  }
  put(b.wood, new BoxGeometry(RIGHT - LEFT, wainH, 0.014), WAINSCOT, [0, FLOOR + wainH / 2, FRONT - 0.007]);
  put(b.wood, roundedBox(RIGHT - LEFT, 0.034, 0.034, 0.006), RAIL, [0, DADO, FRONT - 0.017]);
  // picture rail high on the back wall
  put(b.wood, roundedBox(RIGHT - LEFT, 0.022, 0.02, 0.004), RAIL, [0, 0.82, BACK + 0.01]);

  // ------------------------------------------------------------------ night window: frame, muntins, sill, drapes
  {
    const fw = 0.045;
    const fz = BACK + 0.012;
    const cx = (WIN.x0 + WIN.x1) / 2;
    const w = WIN.x1 - WIN.x0;
    const h = WIN.y1 - WIN.y0;
    const cy = (WIN.y0 + WIN.y1) / 2;
    put(b.wood, roundedBox(w + 2 * fw, fw, 0.03, 0.005), CREAM_PAINT, [cx, WIN.y1 + fw / 2, fz]);
    put(b.wood, roundedBox(fw, h + fw, 0.03, 0.005), CREAM_PAINT, [WIN.x0 - fw / 2, cy + fw / 2, fz]);
    put(b.wood, roundedBox(fw, h + fw, 0.03, 0.005), CREAM_PAINT, [WIN.x1 + fw / 2, cy + fw / 2, fz]);
    const mz = BACK - WIN.depth + 0.012;
    put(b.wood, new BoxGeometry(0.022, h, 0.022), CREAM_PAINT, [cx, cy, mz]);
    for (const y of [WIN.y0 + h * 0.36, WIN.y0 + h * 0.68]) put(b.wood, new BoxGeometry(w, 0.016, 0.018), CREAM_PAINT, [cx, y, mz]);
    // deep sill reaching out to L.window's z
    const sd = WIN.sillFront - (BACK - WIN.depth);
    put(b.wood, roundedBox(w + 0.14, 0.03, sd, 0.006), 0xc9bea6, [cx, WIN.y0 - 0.015, BACK - WIN.depth + sd / 2]);
    put(b.wood, roundedBox(w + 0.06, 0.05, 0.02, 0.004), CREAM_PAINT, [cx, WIN.y0 - 0.055, BACK + 0.012]);
    blobs.push({ x: cx, y: WIN.y0 + 0.001, z: WIN.sillFront - 0.08, sx: 0.12, sz: 0.1, opacity: 0.4, cell: CELL.blobRound });
    // curtain rod + tied-back velvet drapes
    const rodY = WIN.y1 + 0.09;
    put(b.brass, new CylinderGeometry(0.0075, 0.0075, w + 0.34, 10), PAL.brass, [cx, rodY, BACK + 0.07], [0, 0, Math.PI / 2]);
    for (const s of [-1, 1]) put(b.brass, new SphereGeometry(0.016, 14, 10), PAL.brass, [cx + s * (w / 2 + 0.17), rodY, BACK + 0.07]);
    for (const s of [-1, 1]) {
      const dw = 0.2;
      const top = rodY;
      const bot = WIN.y0 - 0.08;
      const drape = new PlaneGeometry(dw, top - bot, 14, 24);
      const p = drape.attributes.position;
      const tieY = WIN.y0 + 0.26;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i) + (top + bot) / 2;
        const dt = Math.abs(y - tieY);
        const pinch = 0.42 + 0.58 * Math.min(1, dt / 0.3);
        const xn = x * pinch - s * (1 - pinch) * dw * 0.32;
        p.setX(i, xn);
        p.setY(i, y);
        p.setZ(i, 0.014 * Math.sin((x * TAU) / 0.05) * pinch + 0.012);
      }
      drape.computeVertexNormals();
      put(b.wood, drape, 0x7a1c2a, [cx + s * (w / 2 + 0.07), 0, BACK + 0.05]);
      put(b.brass, new TorusGeometry(0.03, 0.004, 6, 16), PAL.brass, [cx + s * (w / 2 + 0.07) - s * 0.03, tieY, BACK + 0.075]);
    }
    // sill still-life: terracotta pot + leaves, two bottles, a candle in a jar
    const sy = WIN.y0;
    const sz = WIN.sillFront - 0.1;
    put(b.wood, lathe([[0.001, 0], [0.032, 0], [0.042, 0.06], [0.046, 0.066], [0.046, 0.075], [0.001, 0.075]], 16), 0xa04a2a, [WIN.x0 + 0.12, sy, sz]);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + rand() * 0.4;
      const tilt = 0.5 + rand() * 0.5;
      const leaf = new SphereGeometry(0.03, 8, 6);
      leaf.scale(0.35, 1.6, 0.7);
      put(b.wood, leaf, i % 2 ? 0x2f6a3a : 0x3f8a45, [WIN.x0 + 0.12 + Math.cos(a) * 0.025, sy + 0.11, sz + Math.sin(a) * 0.025], [Math.sin(a) * tilt, a, Math.cos(a) * tilt]);
    }
    put(b.glossy, bottle(0.2, 0.03, 0), 0x1f5a2e, [WIN.x1 - 0.17, sy, sz + 0.01]);
    put(b.glossy, bottle(0.16, 0.026, 1), 0x8a4a14, [WIN.x1 - 0.1, sy, sz - 0.02]);
    put(b.decor, atlasQuad(0.036, 0.036, DECOR.label1), 0xffffff, [WIN.x1 - 0.17, sy + 0.07, sz + 0.0405]);
    put(b.glossy, lathe([[0.001, 0], [0.028, 0], [0.03, 0.006], [0.03, 0.07], [0.027, 0.075], [0.001, 0.075]], 16), 0x8fa6b8, [cx - 0.02, sy, sz + 0.02]);
    put(b.wood, new CylinderGeometry(0.022, 0.022, 0.04, 14), 0xf1e6cf, [cx - 0.02, sy + 0.02, sz + 0.02]);
    glows.push({ x: cx - 0.02, y: sy + 0.052, z: sz + 0.02, size: 0.018, r: 1, g: 0.66, b: 0.3, a: 1, cell: CELL.flame, mode: MODE.upright, twinkle: 0.25, rate: 7, phase: 0.3, lampLinked: false });
    glows.push({ x: cx - 0.02, y: sy + 0.05, z: sz + 0.02, size: 0.11, r: 1, g: 0.55, b: 0.22, a: 0.55, cell: CELL.halo, mode: MODE.billboard, twinkle: 0.18, rate: 5, phase: 1.1, lampLinked: false });
  }

  // ------------------------------------------------------------------ chalkboard menu + midnight clock (left)
  {
    const cx = -1.33;
    const cy = 0.08;
    const w = 0.46;
    const h = 0.575;
    put(b.decor, atlasQuad(w, h, DECOR.chalkboard), 0xffffff, [cx, cy, BACK + 0.016]);
    const fw = 0.028;
    put(b.wood, roundedBox(w + 2 * fw, fw, 0.022, 0.005), 0x5a3a22, [cx, cy + h / 2 + fw / 2, BACK + 0.011]);
    put(b.wood, roundedBox(w + 2 * fw, fw, 0.022, 0.005), 0x5a3a22, [cx, cy - h / 2 - fw / 2, BACK + 0.011]);
    put(b.wood, roundedBox(fw, h, 0.022, 0.005), 0x5a3a22, [cx - w / 2 - fw / 2, cy, BACK + 0.011]);
    put(b.wood, roundedBox(fw, h, 0.022, 0.005), 0x5a3a22, [cx + w / 2 + fw / 2, cy, BACK + 0.011]);
    put(b.wood, new BoxGeometry(w * 0.7, 0.012, 0.03), 0x5a3a22, [cx, cy - h / 2 - fw - 0.004, BACK + 0.026]);
    // clock
    const ky = 0.6;
    const face = new CircleGeometry(0.115, 40);
    const uv = face.attributes.uv;
    const [u0, v0, u1, v1] = DECOR.clock;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    put(b.decor, face, 0xffffff, [cx, ky, BACK + 0.04]);
    put(b.brass, new TorusGeometry(0.12, 0.011, 10, 48), PAL.brass, [cx, ky, BACK + 0.04]);
    put(b.wood, new CylinderGeometry(0.125, 0.125, 0.03, 40), 0x3a2416, [cx, ky, BACK + 0.022], [Math.PI / 2, 0, 0]);
  }

  // ------------------------------------------------------------------ gilt café sign (top centre)
  put(b.decor, atlasQuad(0.66, 0.2475, DECOR.sign), 0xffffff, [0, 1.06, BACK + 0.016]);
  put(b.wood, roundedBox(0.69, 0.275, 0.012, 0.004), 0x24140c, [0, 1.06, BACK + 0.008]);

  // ------------------------------------------------------------------ wall sconce (left of the posters)
  {
    const [x, y, z] = SCONCE;
    put(b.brass, new CylinderGeometry(0.035, 0.035, 0.008, 20), PAL.brass, [x, y - 0.05, BACK + 0.004], [Math.PI / 2, 0, 0]);
    put(b.brass, new CylinderGeometry(0.004, 0.004, 0.09, 8), PAL.brass, [x, y - 0.05, (BACK + z) / 2], [Math.PI / 2, 0, 0]);
    put(b.glossy, lathe([[0.03, 0], [0.026, 0.02], [0.018, 0.045], [0.016, 0.05]], 20), 0xe8d8b8, [x, y - 0.035, z]);
    put(b.emissive, new SphereGeometry(0.012, 12, 8), 0xffe2b0, [x, y - 0.03, z]);
    glows.push({ x, y: y - 0.02, z: z + 0.01, size: 0.2, r: 1, g: 0.62, b: 0.3, a: 0.5, cell: CELL.halo, mode: MODE.billboard, twinkle: 0.03, rate: 0.7, phase: 0, lampLinked: false });
  }

  // ------------------------------------------------------------------ picture light over the poster area
  {
    const [x, y, z] = PICTURE_LIGHT;
    put(b.brass, new CylinderGeometry(0.022, 0.022, 0.46, 20, 1, false, Math.PI * 0.5, Math.PI), PAL.brass, [x, y, z], [0, 0, Math.PI / 2]);
    put(b.emissive, new BoxGeometry(0.44, 0.004, 0.02), 0xffd9a0, [x, y - 0.012, z + 0.002]);
    for (const s of [-1, 1]) put(b.brass, new CylinderGeometry(0.0035, 0.0035, 0.08, 8), PAL.brass, [x + s * 0.15, y + 0.01, (BACK + z) / 2], [Math.PI / 2, 0, 0]);
    for (const s of [-0.16, 0, 0.16]) {
      glows.push({ x: x + s, y: y - 0.03, z: z + 0.012, size: 0.16, r: 1, g: 0.64, b: 0.32, a: 0.32, cell: CELL.halo, mode: MODE.billboard, twinkle: 0, rate: 0, phase: 0, lampLinked: false });
    }
  }

  // ------------------------------------------------------------------ fairy-light garland (catenary swags)
  {
    const hooks = [-2.1, -1.4, -0.7, 0, 0.7, 1.4, 2.1];
    const hookY = 0.95;
    const sag = 0.075;
    const z = BACK + 0.03;
    const pts: Vector3[] = [];
    for (let h = 0; h < hooks.length - 1; h++) {
      const a = hooks[h];
      const c = hooks[h + 1];
      const n = 12;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        pts.push(new Vector3(a + (c - a) * t, hookY - sag * 4 * t * (1 - t), z + 0.006 * Math.sin(t * Math.PI)));
      }
    }
    pts.push(new Vector3(hooks[hooks.length - 1], hookY, z));
    const curve = new CatmullRomCurve3(pts);
    put(b.wood, new TubeGeometry(curve, 240, 0.0016, 4, false), 0x1a2016);
    for (const x of hooks) put(b.brass, new SphereGeometry(0.006, 8, 6), PAL.brass, [x, hookY + 0.004, z - 0.004]);
    const len = curve.getLength();
    const count = Math.floor(len / 0.105);
    const warmCols: Array<[number, number, number]> = [
      [1, 0.72, 0.36],
      [1, 0.84, 0.58],
      [1, 0.62, 0.3],
      [1, 0.55, 0.45],
    ];
    const p = new Vector3();
    for (let i = 0; i < count; i++) {
      curve.getPointAt((i + 0.5) / count, p);
      const [r, g, bb] = warmCols[i % warmCols.length];
      put(b.emissive, new SphereGeometry(0.0062, 8, 6), 0xffe6c0, [p.x, p.y - 0.008, p.z + 0.002]);
      glows.push({ x: p.x, y: p.y - 0.008, z: p.z + 0.006, size: 0.055, r, g, b: bb, a: 0.85, cell: CELL.halo, mode: MODE.billboard, twinkle: 0.45, rate: 0.35 + rand() * 0.5, phase: rand() * TAU, lampLinked: false });
    }
  }

  // ------------------------------------------------------------------ bottle shelves right of the window
  {
    const x0 = WIN.x1 + 0.22;
    const x1 = RIGHT - 0.12;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;
    const cols = [0x1f5a2e, 0x8a4a14, 0x5a1424, 0x8fa6b8, 0x2a4a6a, 0x6a5a14];
    const labels = [DECOR.label0, DECOR.label1, DECOR.label2, DECOR.label3];
    for (const [k, y] of [0.06, 0.4].entries()) {
      put(b.wood, roundedBox(w, 0.022, 0.17, 0.004), 0x6a4428, [cx, y, BACK + 0.085]);
      for (const s of [0.15, 0.85]) put(b.wood, new BoxGeometry(0.018, 0.08, 0.13), 0x4a2c1a, [x0 + w * s, y - 0.05, BACK + 0.07]);
      let x = x0 + 0.06;
      let i = k * 3;
      while (x < x1 - 0.06) {
        const h = 0.17 + rand() * 0.1;
        const r = 0.026 + rand() * 0.014;
        const style = i % 3;
        put(b.glossy, bottle(h, r, style), cols[i % cols.length], [x, y + 0.011, BACK + 0.09]);
        if (i % 2 === 0) put(b.decor, atlasQuad(r * 1.3, r * 1.3, labels[i % 4]), 0xffffff, [x, y + 0.011 + h * 0.36, BACK + 0.09 + r + 0.0015]);
        blobs.push({ x, y: y + 0.0115, z: BACK + 0.09, sx: r * 3, sz: r * 3, opacity: 0.4, cell: CELL.blobRound });
        x += r * 2 + 0.018 + rand() * 0.03;
        i++;
      }
    }
  }

  // ------------------------------------------------------------------ bistro tables with upturned chairs
  const bistro = (tx: number, tz: number, rot: number) => {
    const top = FLOOR + 0.74;
    put(b.wood, new CylinderGeometry(0.3, 0.3, 0.025, 32), 0x8a5432, [tx, top - 0.0125, tz]);
    put(b.brass, new CylinderGeometry(0.018, 0.022, 0.7, 10), 0x3a3030, [tx, FLOOR + 0.36, tz]);
    put(b.brass, new CylinderGeometry(0.2, 0.22, 0.02, 24), 0x3a3030, [tx, FLOOR + 0.01, tz]);
    blobs.push({ x: tx, y: FLOOR + 0.002, z: tz, sx: 0.8, sz: 0.8, opacity: 0.5, cell: CELL.blobRound });
    for (const s of [-1, 1]) {
      const a = rot + (s > 0 ? 0 : Math.PI);
      const ox = tx + Math.cos(a) * 0.1;
      const oz = tz + Math.sin(a) * 0.1;
      // seat lying upside down on the table top, legs to the sky, the bentwood back hanging over the edge
      put(b.wood, new CylinderGeometry(0.17, 0.17, 0.022, 24), 0x7a4a2c, [ox, top + 0.011, oz]);
      for (let k = 0; k < 4; k++) {
        const la = (k / 4) * TAU + Math.PI / 4;
        const lx = ox + Math.cos(la) * 0.12;
        const lz = oz + Math.sin(la) * 0.12;
        put(b.wood, new CylinderGeometry(0.009, 0.011, 0.44, 6), 0x6a3e24, [lx + Math.cos(la) * 0.02, top + 0.24, lz + Math.sin(la) * 0.02], [Math.sin(la) * 0.09, 0, -Math.cos(la) * 0.09]);
      }
      put(b.wood, new TorusGeometry(0.15, 0.006, 6, 24), 0x6a3e24, [ox, top + 0.2, oz], [Math.PI / 2, 0, 0]);
      const back = new TorusGeometry(0.15, 0.008, 6, 20, Math.PI);
      put(b.wood, back, 0x6a3e24, [tx + Math.cos(a) * 0.3, top + 0.005, tz + Math.sin(a) * 0.3], [Math.PI, a + Math.PI / 2, 0]);
    }
  };
  bistro(-1.32, -0.92, 0.4);
  bistro(1.48, -0.55, -0.3);

  // ------------------------------------------------------------------ bar counter on the left wall
  {
    const x0 = LEFT;
    const x1 = LEFT + 0.46;
    const z0 = -1.3;
    const z1 = 0.6;
    const top = -0.15;
    put(b.wood, new BoxGeometry(x1 - x0, top - FLOOR, z1 - z0), 0x4a2a18, [(x0 + x1) / 2, (top + FLOOR) / 2, (z0 + z1) / 2]);
    put(b.glossy, roundedBox(x1 - x0 + 0.06, 0.04, z1 - z0 + 0.06, 0.008), 0xd8d0c2, [(x0 + x1) / 2 + 0.02, top + 0.02, (z0 + z1) / 2]);
    for (let z = z0 + 0.22; z < z1 - 0.1; z += 0.42) {
      put(b.wood, roundedBox(0.012, 0.6, 0.34, 0.004), PANEL, [x1 + 0.006, FLOOR + 0.5, z + 0.1]);
    }
    blobs.push({ x: (x0 + x1) / 2 + 0.06, y: FLOOR + 0.002, z: (z0 + z1) / 2, sx: 0.7, sz: z1 - z0 + 0.25, opacity: 0.55, cell: CELL.blobRect });
    // espresso machine
    const ex = LEFT + 0.2;
    const ez = -0.75;
    const ey = top + 0.04;
    put(b.brass, new CylinderGeometry(0.085, 0.095, 0.28, 24), PAL.brass, [ex, ey + 0.14, ez]);
    put(b.brass, new SphereGeometry(0.085, 24, 12, 0, TAU, 0, Math.PI / 2), PAL.brass, [ex, ey + 0.28, ez]);
    put(b.brass, new SphereGeometry(0.02, 12, 8), PAL.gold, [ex, ey + 0.38, ez]);
    put(b.brass, new ConeGeometry(0.05, 0.08, 16), 0x6a6060, [ex, ey + 0.415, ez]);
    for (const s of [-1, 1]) put(b.brass, new CylinderGeometry(0.012, 0.012, 0.09, 10), 0x8a8888, [ex + 0.1, ey + 0.12, ez + s * 0.04], [0, 0, Math.PI / 2]);
    glows.push({ x: ex + 0.095, y: ey + 0.22, z: ez, size: 0.03, r: 1, g: 0.2, b: 0.12, a: 0.9, cell: CELL.halo, mode: MODE.billboard, twinkle: 0.1, rate: 0.3, phase: 0, lampLinked: false });
    // cake under a glass dome
    const cxk = LEFT + 0.22;
    const czk = -0.1;
    put(b.wood, lathe([[0.001, 0], [0.05, 0], [0.012, 0.03], [0.012, 0.07], [0.14, 0.075], [0.14, 0.085], [0.001, 0.085]], 24), 0xe8e0d0, [cxk, top + 0.04, czk]);
    put(b.wood, new CylinderGeometry(0.1, 0.1, 0.07, 28), 0x6a3a22, [cxk, top + 0.16, czk]);
    put(b.wood, new CylinderGeometry(0.102, 0.102, 0.012, 28), 0xf2e8d8, [cxk, top + 0.2, czk]);
    put(b.glossy, new SphereGeometry(0.13, 24, 12, 0, TAU, 0, Math.PI / 2), 0x3a4a5a, [cxk, top + 0.125, czk], undefined, [1, 1.15, 1]);
    // shelves + jars above the bar
    for (const y of [0.25, 0.58]) {
      put(b.wood, roundedBox(0.2, 0.022, 1.5, 0.004), 0x6a4428, [LEFT + 0.1, y, -0.45]);
      let z = -1.12;
      let i = 0;
      while (z < 0.25) {
        const h = 0.16 + rand() * 0.12;
        const r = 0.03 + rand() * 0.015;
        put(b.glossy, bottle(h, r, i % 3), [0x1f5a2e, 0x8a4a14, 0x5a1424, 0x8fa6b8][i % 4], [LEFT + 0.1, y + 0.011, z]);
        z += r * 2 + 0.03 + rand() * 0.04;
        i++;
      }
    }
  }

  // ------------------------------------------------------------------ potted palm in the back-left corner
  {
    const px = LEFT + 0.3;
    const pz = BACK + 0.32;
    put(b.wood, lathe([[0.001, 0], [0.13, 0], [0.16, 0.34], [0.175, 0.36], [0.175, 0.39], [0.001, 0.39]], 20), 0x8a3e22, [px, FLOOR, pz]);
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * TAU + rand() * 0.3;
      const lean = 0.5 + rand() * 0.7;
      const frond = new ConeGeometry(0.06, 0.75 + rand() * 0.35, 4, 1);
      frond.scale(1, 1, 0.2);
      frond.translate(0, 0.4, 0);
      put(b.wood, frond, i % 2 ? 0x24532e : 0x2f6a38, [px, FLOOR + 0.36, pz], [Math.sin(a) * lean, a, Math.cos(a) * lean]);
    }
    blobs.push({ x: px, y: FLOOR + 0.002, z: pz, sx: 0.5, sz: 0.5, opacity: 0.5, cell: CELL.blobRound });
  }

  // ------------------------------------------------------------------ behind the player: door + a top hat on a hook
  {
    const dx = DOOR.x;
    put(b.wood, roundedBox(0.92, 2.08, 0.05, 0.008), 0x4a2c1a, [dx, FLOOR + 1.04, FRONT - 0.03]);
    put(b.wood, roundedBox(0.78, 1.98, 0.04, 0.006), 0x5c3822, [dx, FLOOR + 0.99, FRONT - 0.05]);
    put(b.wood, roundedBox(0.6, 0.5, 0.012, 0.004), PANEL, [dx, FLOOR + 0.6, FRONT - 0.075]);
    // glazed upper half: a frame + muntins around the night pane (see makeNightPane)
    const gy = FLOOR + DOOR_GLASS.y;
    put(b.wood, roundedBox(DOOR_GLASS.w + 0.05, 0.03, 0.03, 0.005), CREAM_PAINT, [dx, gy + DOOR_GLASS.h / 2 + 0.015, FRONT - 0.08]);
    put(b.wood, roundedBox(DOOR_GLASS.w + 0.05, 0.03, 0.03, 0.005), CREAM_PAINT, [dx, gy - DOOR_GLASS.h / 2 - 0.015, FRONT - 0.08]);
    for (const sx of [-1, 1]) put(b.wood, roundedBox(0.03, DOOR_GLASS.h, 0.03, 0.005), CREAM_PAINT, [dx + sx * (DOOR_GLASS.w / 2 + 0.01), gy, FRONT - 0.08]);
    put(b.wood, new BoxGeometry(0.016, DOOR_GLASS.h, 0.016), CREAM_PAINT, [dx, gy, FRONT - 0.085]);
    put(b.wood, new BoxGeometry(DOOR_GLASS.w, 0.016, 0.016), CREAM_PAINT, [dx, gy, FRONT - 0.085]);
    put(b.brass, new SphereGeometry(0.025, 12, 8), PAL.brass, [dx - 0.31, FLOOR + 1.0, FRONT - 0.09]);
    const hx = -0.7;
    const hy = 0.35;
    put(b.brass, new CylinderGeometry(0.006, 0.006, 0.1, 8), PAL.brass, [hx, hy, FRONT - 0.05], [Math.PI / 2, 0, 0]);
    put(b.wood, new CylinderGeometry(0.1, 0.1, 0.008, 28), PAL.hatBlack, [hx, hy - 0.09, FRONT - 0.13], [0.25, 0, 0]);
    put(b.wood, new CylinderGeometry(0.068, 0.072, 0.16, 28), PAL.hatBlack, [hx, hy - 0.01, FRONT - 0.15], [0.25, 0, 0]);
    put(b.wood, new CylinderGeometry(0.073, 0.073, 0.022, 28), 0x8a1a25, [hx, hy - 0.07, FRONT - 0.145], [0.25, 0, 0]);
  }

  // ------------------------------------------------------------------ the night pane (one shader quad)
  const windowPane = makeNightPane();
  return { blobs, glows, windowPane };
}

/** Deep-blue night: gradient sky, twinkling stars, a crescent moon, rooftops with warm windows, glass sheen. */
function makeNightPane(): Mesh<BufferGeometry, ShaderMaterial> {
  const w = WIN.x1 - WIN.x0;
  const h = WIN.y1 - WIN.y0;
  // the window pane + the glass of the café door behind the player: one geometry, one draw call
  const geo = mergeParts(
    [
      { geometry: new PlaneGeometry(w, h, 1, 1), color: 0xffffff, position: [(WIN.x0 + WIN.x1) / 2, (WIN.y0 + WIN.y1) / 2, BACK - WIN.depth] },
      {
        geometry: new PlaneGeometry(DOOR_GLASS.w, DOOR_GLASS.h, 1, 1),
        color: 0xffffff,
        position: [DOOR.x, FLOOR + DOOR_GLASS.y, FRONT - 0.076],
        rotation: [0, Math.PI, 0],
      },
    ],
    { keepUv: true },
  );
  const mat = new ShaderMaterial({
    name: 'env-night',
    uniforms: { uTime: { value: 0 }, uAspect: { value: w / h } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uAspect;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 uv = vUv;
        vec2 p = vec2(uv.x * uAspect, uv.y);
        // sky: deep navy at the top, glowing indigo near the rooftops
        vec3 col = mix(vec3(0.05, 0.075, 0.32), vec3(0.008, 0.012, 0.075), smoothstep(0.12, 0.95, uv.y));
        // moon (crescent) with a soft glow
        vec2 mc = vec2(0.66 * uAspect, 0.8);
        float dm = length(p - mc);
        col += vec3(0.35, 0.42, 0.75) * exp(-dm * dm * 26.0) * 0.32;
        float disk = 1.0 - smoothstep(0.066, 0.072, dm);
        float bite = 1.0 - smoothstep(0.06, 0.066, length(p - mc - vec2(0.03, 0.022)));
        col = mix(col, vec3(1.0, 0.96, 0.82), disk * (1.0 - bite));
        // stars, each twinkling at its own rate
        vec2 g = p * 34.0;
        vec2 id = floor(g);
        vec2 f = fract(g) - 0.5;
        float hs = hash(id);
        if (hs > 0.8) {
          vec2 o = vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5;
          float d = length(f - o * 0.6);
          float tw = 0.45 + 0.55 * sin(uTime * (1.2 + hs * 3.5) + hs * 40.0);
          float star = (1.0 - smoothstep(0.0, 0.14, d)) * (hs - 0.8) * 5.0 * tw;
          col += vec3(0.85, 0.9, 1.0) * star * smoothstep(0.25, 0.45, uv.y);
        }
        // rooftops: stepped silhouettes with chimneys and warm windows
        float bx = floor(p.x * 7.0);
        float bh = 0.1 + 0.2 * hash(vec2(bx, 2.0));
        float roof = bh + 0.05 * (1.0 - abs(fract(p.x * 7.0) - 0.5) * 2.0) * step(0.5, hash(vec2(bx, 5.0)));
        float chim = step(0.72, hash(vec2(bx, 9.0))) * step(abs(fract(p.x * 7.0) - 0.3), 0.06) * step(uv.y, roof + 0.05);
        float building = max(step(uv.y, roof), chim);
        vec3 bcol = vec3(0.012, 0.014, 0.04);
        vec2 wg = vec2(p.x * 7.0 * 4.0, uv.y * 30.0);
        vec2 wid = floor(wg);
        vec2 wf = fract(wg);
        float lit = step(0.7, hash(wid + bx));
        float pulse = 0.75 + 0.25 * sin(uTime * 0.3 + hash(wid) * 30.0);
        float win = lit * step(0.25, wf.x) * step(wf.x, 0.75) * step(0.3, wf.y) * step(wf.y, 0.8) * step(uv.y, bh - 0.025);
        bcol += vec3(1.0, 0.62, 0.25) * win * 0.55 * pulse;
        col = mix(col, bcol, building);
        // a faint warm reflection of the café lamp on the glass + edge vignette
        col += vec3(0.5, 0.3, 0.12) * exp(-((uv.x - 0.15) * (uv.x - 0.15) * 30.0 + (uv.y - 0.25) * (uv.y - 0.25) * 18.0)) * 0.08;
        col *= 0.75 + 0.25 * smoothstep(0.0, 0.12, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    toneMapped: false,
  });
  const m = new Mesh(geo, mat);
  m.name = 'env-nightWindow';
  return m;
}
