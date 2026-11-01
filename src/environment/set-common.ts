// Shared types/constants for the static café set builders.
import type { BufferGeometry } from '@iwsdk/core';
import type { Part } from '../art/geometry.js';
import { L } from '../layout.js';

/** Static parts sorted by the material they will be merged into (one draw call per bucket). */
export interface Buckets {
  /** MeshBasic + wallpaper map + baked vertex light (walls, floor, ceiling). Every part needs UVs. */
  room: Part[];
  /** 'wood' matcap, baked light (furniture, frames, fabric trims). */
  wood: Part[];
  /** 'brass' matcap (fittings, rails, lamp trims). */
  brass: Part[];
  /** 'glossy' matcap (bottles, enamel shade). */
  glossy: Part[];
  /** Unlit, not tone-mapped (bulbs, lamp interior). */
  emissive: Part[];
  /** MeshBasic + décor atlas (chalkboard, clock face, labels, sign). Every part needs UVs. */
  decor: Part[];
}

export function newBuckets(): Buckets {
  return { room: [], wood: [], brass: [], glossy: [], emissive: [], decor: [] };
}

export function put(
  bucket: Part[],
  geometry: BufferGeometry,
  color: number,
  position?: [number, number, number],
  rotation?: [number, number, number],
  scale?: [number, number, number] | number,
): void {
  bucket.push({ geometry, color, position, rotation, scale });
}

/** A twinkling/pulsing static glow the café animates each frame. */
export interface StaticGlow {
  slot: number;
  x: number;
  y: number;
  z: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
  cell: number;
  mode: number;
  /** 0 = steady; otherwise twinkle depth 0..1 at `rate` Hz with `phase`. */
  twinkle: number;
  rate: number;
  phase: number;
  /** Scales with the lamp level (lamp halo, pool). */
  lampLinked: boolean;
}

export interface StaticBlob {
  x: number;
  y: number;
  z: number;
  sx: number;
  sz: number;
  opacity: number;
  cell: number;
  rot?: number;
}

export const T = L.tableY;
export const FLOOR = -1.18;
export const CEIL = 1.26;
export const BACK = -1.615; // back wall surface (posterWall anchor sits 1.5 cm in front of it)
export const LEFT = -2.3;
export const RIGHT = 2.3;
export const FRONT = 1.9;
export const DADO = -0.37; // top of the wainscot
export const WIN = {
  x0: L.window.center[0] - L.window.size[0] / 2,
  x1: L.window.center[0] + L.window.size[0] / 2,
  y0: L.window.center[1] - L.window.size[1] / 2,
  y1: L.window.center[1] + L.window.size[1] / 2,
  depth: 0.12, // pane recess behind the wall surface
  sillFront: L.window.center[2], // sill nose reaches L.window z
};
/** Extra warm point lights baked into the backdrop: [x, y, z, radius, gain]. */
export const SCONCE: readonly [number, number, number] = [-0.98, 0.4, BACK + 0.09];
export const PICTURE_LIGHT: readonly [number, number, number] = [0, 0.66, BACK + 0.07];
export const EXTRA_LIGHTS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [SCONCE[0], SCONCE[1] - 0.04, SCONCE[2] + 0.02, 0.32, 0.55],
  [PICTURE_LIGHT[0], PICTURE_LIGHT[1] - 0.14, PICTURE_LIGHT[2] + 0.05, 0.4, 0.75],
  // light leaking up through the lamp's cap vents onto the ceiling
  [L.lamp[0], L.lamp[1] + 0.5, L.lamp[2], 0.55, 0.16],
];
