// Baked "lighting" for the café (rig-local space). Every static surface gets its light level written into its
// vertex colours once at build time: a warm, downward-coned pendant lamp, a soft warm bounce off the bright cloth,
// cool moonlight from the window and a deep-blue ambient. No real-time lights, no shadow maps.
import { Color } from '@iwsdk/core';
import { L } from '../layout.js';
import { smoothstep } from './util.js';

export const LAMP = { x: L.lamp[0], y: L.lamp[1], z: L.lamp[2] };
const TABLE = { y: L.tableY, z: L.table.centerZ, hw: L.table.width / 2, hd: L.table.depth / 2 };
const WIN = { x: L.window.center[0], y: L.window.center[1], z: -1.6 };

// linear colours
const LAMP_C = new Color(1.0, 0.66, 0.36);
const BOUNCE_C = new Color(1.0, 0.62, 0.42);
const WIN_C = new Color(0.32, 0.42, 1.0);
const AMB_C = new Color(0.05, 0.056, 0.13);

export interface LightOpts {
  lamp?: number;
  bounce?: number;
  window?: number;
  ambient?: number;
  /** Treat the point as shadowed by the tabletop when it is below it (floor, legs). */
  tableShadow?: boolean;
  /** Extra local warm lights (wall sconces, picture light): [x, y, z, radius, gain]. */
  extra?: ReadonlyArray<readonly [number, number, number, number, number]>;
}

const tmp = new Color();

/** Light multiplier at a rig-local point with a normal (written into `out`). */
export function lightAt(px: number, py: number, pz: number, nx: number, ny: number, nz: number, out: Color, o: LightOpts = {}): Color {
  out.setRGB(0, 0, 0);
  // --- pendant lamp: a downward cone with soft inverse-square-ish falloff, normalised to 1 at the mat
  {
    const dx = px - LAMP.x;
    const dy = py - LAMP.y;
    const dz = pz - LAMP.z;
    const d = Math.max(0.05, Math.hypot(dx, dy, dz));
    const down = -dy / d;
    const cone = smoothstep(0.78, 0.985, down);
    const atten = (1 + (0.74 / 0.3) ** 2) / (1 + (d / 0.3) ** 2);
    const lam = Math.max(0, -(nx * dx + ny * dy + nz * dz) / d);
    let k = (o.lamp ?? 1) * cone * atten * (0.25 + 0.75 * lam);
    if (o.tableShadow && py < TABLE.y - 0.01) {
      // ray from the point to the lamp crosses the tabletop plane → inside the table rect = shadow
      const t = (TABLE.y - py) / (LAMP.y - py);
      const ix = px + (LAMP.x - px) * t;
      const iz = pz + (LAMP.z - pz) * t;
      const ex = Math.abs(ix) - TABLE.hw;
      const ez = Math.abs(iz - TABLE.z) - TABLE.hd;
      k *= 0.08 + 0.92 * smoothstep(-0.05, 0.12, Math.max(ex, ez));
    }
    out.r += LAMP_C.r * k;
    out.g += LAMP_C.g * k;
    out.b += LAMP_C.b * k;
  }
  // --- warm bounce off the lit tablecloth (a broad area light at the table centre)
  {
    const dx = px;
    const dy = py - TABLE.y;
    const dz = pz - TABLE.z;
    const d = Math.max(0.05, Math.hypot(dx, dy, dz));
    const lam = Math.max(0, -(nx * dx + ny * dy + nz * dz) / d);
    const k = (o.bounce ?? 1) * 0.2 * (0.35 + 0.65 * lam) / (1 + (d / 0.6) ** 2);
    out.r += BOUNCE_C.r * k;
    out.g += BOUNCE_C.g * k;
    out.b += BOUNCE_C.b * k;
  }
  // --- cool moonlight through the window (shines toward +Z, into the room)
  {
    const dx = px - WIN.x;
    const dy = py - WIN.y;
    const dz = pz - WIN.z;
    const d = Math.max(0.05, Math.hypot(dx, dy, dz));
    const front = smoothstep(-0.05, 0.25, dz / d);
    const lam = Math.max(0, -(nx * dx + ny * dy + nz * dz) / d);
    const k = (o.window ?? 1) * 0.5 * front * (0.35 + 0.65 * lam) / (1 + (d / 0.75) ** 2);
    out.r += WIN_C.r * k;
    out.g += WIN_C.g * k;
    out.b += WIN_C.b * k;
  }
  // --- extra small warm lights
  if (o.extra) {
    for (const [lx, ly, lz, rad, gain] of o.extra) {
      const dx = px - lx;
      const dy = py - ly;
      const dz = pz - lz;
      const d = Math.max(0.03, Math.hypot(dx, dy, dz));
      const lam = Math.max(0, -(nx * dx + ny * dy + nz * dz) / d);
      const k = (gain * (0.3 + 0.7 * lam)) / (1 + (d / rad) ** 2);
      out.r += LAMP_C.r * k;
      out.g += LAMP_C.g * k;
      out.b += LAMP_C.b * k;
    }
  }
  // --- ambient night (slightly brighter on up-facing surfaces)
  const amb = (o.ambient ?? 1) * (0.8 + 0.2 * ny);
  out.r += AMB_C.r * amb;
  out.g += AMB_C.g * amb;
  out.b += AMB_C.b * amb;
  return out;
}

/** Scalar light level (luma of `lightAt`) for tinting dynamic objects (gadgets) by position. */
export function lightLevelAt(px: number, py: number, pz: number): number {
  lightAt(px, py, pz, 0, 0.6, 0.8, tmp);
  return 0.2126 * tmp.r + 0.7152 * tmp.g + 0.0722 * tmp.b;
}
