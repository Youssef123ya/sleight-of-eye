// The performance area: draped gingham cloth, velvet close-up mat, audience riser, gadget shelf, pendant lamp.
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Mesh,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector4,
  type ShaderMaterial,
} from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import { L } from '../layout.js';
import { CELL } from './textures.js';
import { MODE } from './glow.js';
import { AdditiveBlending, KIND, envShaderMaterial } from './shader.js';
import { CEIL, FLOOR, T, put, type Buckets, type StaticBlob } from './set-common.js';
import { ensureColor, lathe, roundedBox, roundedRectShape, starPlate, TAU } from './util.js';

// ------------------------------------------------------------------------------------------------- cloth

/** Tablecloth: a fine top grid (for baked light) plus a draped skirt with folds; UVs unfold over the edge. */
export function clothGeometry(): BufferGeometry {
  const hw = L.table.width / 2;
  const hd = L.table.depth / 2;
  const zc = L.table.centerZ;
  const rc = 0.035;
  const TILE = 0.072; // one gingham tile (4×4 checks) per 7.2 cm → 1.8 cm checks
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  // --- top grid (corners pulled onto the rounded outline)
  const NX = 44;
  const NZ = 34;
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      let x = -hw + (i / NX) * 2 * hw;
      let z = zc - hd + (j / NZ) * 2 * hd;
      const ax = Math.abs(x) - (hw - rc);
      const az = Math.abs(z - zc) - (hd - rc);
      if (ax > 0 && az > 0) {
        const l = Math.hypot(ax, az);
        if (l > rc) {
          const k = rc / l;
          x = Math.sign(x) * (hw - rc + ax * k);
          z = zc + Math.sign(z - zc) * (hd - rc + az * k);
        }
      }
      pos.push(x, T, z);
      nor.push(0, 1, 0);
      uv.push(x / TILE, -z / TILE);
    }
  }
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i;
      const b = a + 1;
      const c = a + NX + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  // --- perimeter path (rounded rect), walked front → left → back → right
  const path: Array<{ x: number; z: number; ox: number; oz: number; s: number; corner: number }> = [];
  const cx = hw - rc;
  const czf = zc + hd - rc;
  const czb = zc - hd + rc;
  const segs: Array<{ kind: 'line'; x0: number; z0: number; x1: number; z1: number; th: number } | { kind: 'arc'; cx: number; cz: number; th0: number; th1: number }> = [
    { kind: 'line', x0: cx, z0: zc + hd, x1: -cx, z1: zc + hd, th: Math.PI / 2 },
    { kind: 'arc', cx: -cx, cz: czf, th0: Math.PI / 2, th1: Math.PI },
    { kind: 'line', x0: -hw, z0: czf, x1: -hw, z1: czb, th: Math.PI },
    { kind: 'arc', cx: -cx, cz: czb, th0: Math.PI, th1: Math.PI * 1.5 },
    { kind: 'line', x0: -cx, z0: zc - hd, x1: cx, z1: zc - hd, th: Math.PI * 1.5 },
    { kind: 'arc', cx: cx, cz: czb, th0: Math.PI * 1.5, th1: TAU },
    { kind: 'line', x0: hw, z0: czb, x1: hw, z1: czf, th: 0 },
    { kind: 'arc', cx: cx, cz: czf, th0: 0, th1: Math.PI / 2 },
  ];
  const STEP = 0.014;
  let s = 0;
  for (const sg of segs) {
    if (sg.kind === 'line') {
      const len = Math.hypot(sg.x1 - sg.x0, sg.z1 - sg.z0);
      const n = Math.max(1, Math.round(len / STEP));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // "cornerness" ramps up near the ends of each side so corners hang lower
        const endDist = Math.min(t, 1 - t) * len;
        path.push({
          x: sg.x0 + (sg.x1 - sg.x0) * t,
          z: sg.z0 + (sg.z1 - sg.z0) * t,
          ox: Math.cos(sg.th),
          oz: Math.sin(sg.th),
          s,
          corner: Math.max(0, 1 - endDist / 0.12),
        });
        s += len / n;
      }
    } else {
      const n = 6;
      for (let i = 0; i < n; i++) {
        const th = sg.th0 + ((sg.th1 - sg.th0) * i) / n;
        path.push({ x: sg.cx + Math.cos(th) * rc, z: sg.cz + Math.sin(th) * rc, ox: Math.cos(th), oz: Math.sin(th), s, corner: 1 });
        s += (rc * (sg.th1 - sg.th0)) / n;
      }
    }
  }

  // --- skirt rings: lip over the edge, then a hanging drape with folds and lower corners
  const R = 9;
  const base = pos.length / 3;
  const K = path.length;
  for (let k = 0; k < K; k++) {
    const p = path[k];
    const corner = p.corner * p.corner * (3 - 2 * p.corner);
    const hang = 0.23 + 0.05 * corner;
    const foldA = 0.009 * Math.sin((p.s * TAU) / 0.13) + 0.004 * Math.sin((p.s * TAU) / 0.051 + 1.3);
    for (let r = 0; r <= R; r++) {
      let out: number;
      let y: number;
      let dist: number;
      if (r === 0) {
        out = 0;
        y = T;
        dist = 0;
      } else if (r === 1) {
        out = 0.0055;
        y = T - 0.0045;
        dist = 0.008;
      } else {
        const d = (r - 1) / (R - 1);
        out = 0.008 + (0.012 + 0.03 * corner) * d * d + foldA * d;
        y = T - 0.008 - hang * d;
        dist = 0.012 + hang * d;
      }
      pos.push(p.x + p.ox * out, y, p.z + p.oz * out);
      const nl = Math.hypot(p.ox, 0.12, p.oz);
      nor.push(p.ox / nl, r === 0 ? 1 : 0.12 / nl, p.oz / nl);
      uv.push((p.x + p.ox * dist) / TILE, -(p.z + p.oz * dist) / TILE);
    }
  }
  for (let k = 0; k < K; k++) {
    for (let r = 0; r < R; r++) {
      const a = base + k * (R + 1) + r;
      const b = base + ((k + 1) % K) * (R + 1) + r;
      const c = a + 1;
      const d = b + 1;
      idx.push(a, b, c, b, d, c);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// --------------------------------------------------------------------------------------------------- mat

/** The velvet mat slab: from the cloth (L.tableY) up to L.mat.top, bevelled, UVs across the top; white vertex colours. */
export function matGeometry(): BufferGeometry {
  const [mw, md] = L.mat.size;
  const bevel = 0.0016;
  const g = new ExtrudeGeometry(roundedRectShape(mw - 2 * bevel, md - 2 * bevel, 0.012), {
    depth: L.mat.top - T - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(L.mat.center[0], T + bevel, L.mat.center[2]);
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const lx = p.getX(i) - L.mat.center[0];
    const lz = p.getZ(i) - L.mat.center[2];
    uv[i * 2] = Math.min(1, Math.max(0, (lx + mw / 2) / mw));
    uv[i * 2 + 1] = Math.min(1, Math.max(0, (-lz + md / 2) / md));
  }
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  return ensureColor(g);
}

// ------------------------------------------------------------------------------------- furniture + lamp

/** Table legs, riser, shelf, pedestal, lamp fixtures → buckets; returns static blobs for them. */
export function buildStage(b: Buckets): StaticBlob[] {
  const blobs: StaticBlob[] = [];
  const woodMid = 0x7a4a2a;
  const woodTop = 0x9a6438;

  // --- turned table legs (visible below the cloth)
  const legProfile: Array<[number, number]> = [
    [0.001, 0],
    [0.024, 0],
    [0.027, 0.02],
    [0.019, 0.06],
    [0.015, 0.2],
    [0.016, 0.36],
    [0.023, 0.41],
    [0.016, 0.46],
    [0.017, 0.7],
    [0.026, 0.76],
    [0.026, (T - 0.02) - FLOOR],
    [0.001, (T - 0.02) - FLOOR],
  ];
  const leg = lathe(legProfile, 14);
  for (const x of [-0.47, 0.47]) {
    for (const z of [-0.2, -0.9]) {
      put(b.wood, leg, PAL.woodDark, [x, FLOOR, z]);
      blobs.push({ x, y: FLOOR + 0.002, z, sx: 0.16, sz: 0.16, opacity: 0.55, cell: CELL.blobRound });
    }
  }
  blobs.push({ x: 0, y: FLOOR + 0.0015, z: L.table.centerZ, sx: 1.5, sz: 1.2, opacity: 0.72, cell: CELL.blobRect });

  // --- audience riser: a tiny theatre bench with a red pleated valance and gold rope
  const rz = L.riser.z;
  const rw = L.riser.width;
  const rd = L.riser.depth;
  const top = L.riser.topY;
  put(b.wood, new BoxGeometry(rw - 0.006, top - T - 0.008, rd - 0.006), woodMid, [0, T + (top - T - 0.008) / 2, rz]);
  put(b.wood, roundedBox(rw + 0.012, 0.008, rd + 0.01, 0.003), woodTop, [0, top - 0.004, rz]);
  {
    // front + side valance: pleated, scalloped red felt
    const val = new PlaneGeometry(rw, 1, 64, 1);
    const pa = val.attributes.position;
    const h = top - T - 0.008;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i);
      const isTop = pa.getY(i) > 0;
      const scallop = 0.0055 * Math.abs(Math.sin((x * Math.PI) / 0.05));
      pa.setY(i, isTop ? h : 0.0015 + scallop);
      pa.setZ(i, 0.0022 * Math.sin((x * TAU) / 0.022));
    }
    val.computeVertexNormals();
    put(b.wood, val, 0x9a1f2a, [0, T, rz + rd / 2 + 0.0035]);
    const side = new PlaneGeometry(rd, 1, 12, 1);
    const ps = side.attributes.position;
    for (let i = 0; i < ps.count; i++) {
      const x = ps.getX(i);
      const isTop = ps.getY(i) > 0;
      ps.setY(i, isTop ? h : 0.0015 + 0.0055 * Math.abs(Math.sin((x * Math.PI) / 0.05)));
      ps.setZ(i, 0.0018 * Math.sin((x * TAU) / 0.022));
    }
    side.computeVertexNormals();
    put(b.wood, side, 0x8a1a25, [rw / 2 + 0.0035, T, rz], [0, Math.PI / 2, 0]);
    put(b.wood, side, 0x8a1a25, [-rw / 2 - 0.0035, T, rz], [0, -Math.PI / 2, 0]);
  }
  put(b.brass, new CylinderGeometry(0.0026, 0.0026, rw + 0.012, 10), PAL.brass, [0, top - 0.0085, rz + rd / 2 + 0.006], [0, 0, Math.PI / 2]);
  for (const sx of [-1, 1]) put(b.brass, new SphereGeometry(0.0048, 12, 8), PAL.gold, [sx * (rw / 2 + 0.007), top - 0.0085, rz + rd / 2 + 0.006]);
  const seatCols = [0xd9a441, 0x2a8f8c, 0xc0475a, 0x2a8f8c, 0xd9a441];
  L.seats.forEach((p, i) => put(b.wood, new CylinderGeometry(0.023, 0.024, 0.002, 28), seatCols[i], [p[0], top + 0.001, p[2]]));
  blobs.push({ x: 0, y: T + 0.0012, z: rz, sx: rw + 0.07, sz: rd + 0.06, opacity: 0.55, cell: CELL.blobRect });

  // --- gadget shelf (long low bench) + raised firework pedestal
  const sz = L.shelf.z;
  const sTop = L.shelf.topY;
  const sw = 0.96;
  const sd = 0.12;
  put(b.wood, new BoxGeometry(sw - 0.01, sTop - T - 0.01, sd - 0.008), 0x5a341e, [0, T + (sTop - T - 0.01) / 2, sz]);
  put(b.wood, roundedBox(sw + 0.01, 0.01, sd + 0.012, 0.0035), woodTop, [0, sTop - 0.005, sz]);
  for (const x of [-0.31, 0, 0.31]) {
    put(b.wood, roundedBox(0.25, 0.066, 0.004, 0.0015), 0x6e4026, [x, T + 0.054, sz + sd / 2 - 0.002]);
    put(b.wood, roundedBox(0.21, 0.044, 0.003, 0.0012), 0x4a2a17, [x, T + 0.054, sz + sd / 2 + 0.001]);
  }
  put(b.brass, new CylinderGeometry(0.0022, 0.0022, sw + 0.01, 10), PAL.brass, [0, sTop - 0.012, sz + sd / 2 + 0.005], [0, 0, Math.PI / 2]);
  {
    const fw = L.gadgets.firework;
    const ph = fw[1] - T;
    put(b.wood, roundedBox(0.13, ph - 0.01, 0.1, 0.004), 0x5a341e, [fw[0], T + (ph - 0.01) / 2, fw[2]]);
    put(b.wood, roundedBox(0.142, 0.01, 0.112, 0.0035), woodTop, [fw[0], fw[1] - 0.005, fw[2]]);
    const star = starPlate(0.016, 0.0068, 0.003);
    put(b.brass, star, PAL.gold, [fw[0], T + ph * 0.55, fw[2] + 0.05 + 0.001], [Math.PI / 2, 0, 0]);
    blobs.push({ x: fw[0], y: T + 0.0012, z: fw[2], sx: 0.18, sz: 0.14, opacity: 0.5, cell: CELL.blobRect });
  }
  blobs.push({ x: 0, y: T + 0.0012, z: sz, sx: sw + 0.08, sz: sd + 0.06, opacity: 0.55, cell: CELL.blobRect });
  // soft occlusion around the mat edge
  blobs.push({ x: L.mat.center[0], y: T + 0.0008, z: L.mat.center[2], sx: L.mat.size[0] + 0.035, sz: L.mat.size[1] + 0.035, opacity: 0.28, cell: CELL.blobRect });

  // --- pendant lamp: cord, canopy, brass cap, enamel shade, warm interior, bulb
  const [lx, ly, lz] = L.lamp;
  const rimY = ly - 0.028;
  put(b.wood, new CylinderGeometry(0.0028, 0.0028, CEIL - (rimY + 0.18), 6), 0x1a1412, [lx, (CEIL + rimY + 0.18) / 2, lz]);
  put(b.brass, new CylinderGeometry(0.045, 0.05, 0.016, 24), PAL.brass, [lx, CEIL - 0.008, lz]);
  put(b.brass, lathe([[0.001, 0], [0.024, 0], [0.026, 0.012], [0.02, 0.028], [0.012, 0.034], [0.006, 0.05], [0.001, 0.05]], 20), PAL.brass, [lx, rimY + 0.138, lz]);
  const outer: Array<[number, number]> = [
    [0.116, 0],
    [0.114, 0.01],
    [0.103, 0.04],
    [0.085, 0.074],
    [0.064, 0.1],
    [0.043, 0.12],
    [0.027, 0.133],
    [0.02, 0.139],
  ];
  put(b.glossy, lathe(outer, 40), 0x1d5a3c, [lx, rimY, lz]);
  const inner = outer.map(([r, y]) => [r - 0.004, y + 0.002] as [number, number]).reverse();
  put(b.emissive, lathe(inner, 40), 0xffffff, [lx, rimY, lz]);
  put(b.brass, new TorusGeometry(0.116, 0.004, 8, 48), PAL.brass, [lx, rimY, lz], [Math.PI / 2, 0, 0]);
  put(b.brass, new CylinderGeometry(0.014, 0.012, 0.03, 16), PAL.brass, [lx, ly + 0.034, lz]);
  put(b.emissive, new SphereGeometry(0.024, 24, 16), 0xffffff, [lx, ly + 0.004, lz]);
  return blobs;
}

/** Interior/bulb gradient for the emissive bucket: hot near the bulb, amber toward the rim; others untouched. */
export function lampEmissiveColor(px: number, py: number, pz: number, out: { r: number; g: number; b: number }): boolean {
  const [lx, ly, lz] = L.lamp;
  const d = Math.hypot(px - lx, py - ly, pz - lz);
  if (d > 0.18) return false;
  if (d < 0.028) {
    out.r = 1.0;
    out.g = 0.94;
    out.b = 0.8;
    return true;
  }
  const t = Math.pow(Math.min(1, (d - 0.028) / 0.1), 0.8);
  out.r = 0.95 * (1 - t) + 0.36 * t;
  out.g = 0.66 * (1 - t) + 0.15 * t;
  out.b = 0.34 * (1 - t) + 0.05 * t;
  return true;
}

/**
 * Faint volumetric cone under the lamp (front faces only, additive, fades toward the cloth) on the shared program:
 * uTint = rgb colour, a = lamp level.
 */
export function makeBeam(): Mesh<BufferGeometry, ShaderMaterial> {
  const [lx, ly, lz] = L.lamp;
  const top = ly - 0.03;
  const bottom = T + 0.004;
  const h = top - bottom;
  const geo = new CylinderGeometry(0.125, 0.44, h, 48, 6, true);
  const mat = envShaderMaterial({
    name: 'env-beam',
    kind: KIND.beam,
    uniforms: { uTint: { value: new Vector4(1.0, 0.68, 0.36, 1) }, uBeamH: { value: h } },
    blending: AdditiveBlending,
  });
  const m = new Mesh(geo, mat);
  m.name = 'env-lampBeam';
  m.position.set(lx, bottom + h / 2, lz);
  m.renderOrder = 19;
  return m;
}

/** Lamp halo + warm pool (GlowBatch flat decal, just above the mat top so it also lies on the velvet) descriptors. */
export const LAMP_GLOWS = {
  halo: { x: L.lamp[0], y: L.lamp[1] - 0.01, z: L.lamp[2], size: 0.26, r: 1.0, g: 0.58, b: 0.26, a: 0.42, cell: CELL.halo, mode: MODE.billboard },
  core: { x: L.lamp[0], y: L.lamp[1] - 0.004, z: L.lamp[2], size: 0.075, r: 1.0, g: 0.86, b: 0.62, a: 0.6, cell: CELL.halo, mode: MODE.billboard },
  pool: { x: L.lamp[0], y: L.mat.top + 0.0008, z: L.lamp[2] + 0.04, size: 0.86, r: 1.0, g: 0.58, b: 0.24, a: 0.3, cell: CELL.pool, mode: MODE.flat },
};

