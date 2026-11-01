// ONE shader program for every opaque surface the café draws (room shell, décor, cloth, velvet mat, furniture, props,
// gadgets, watch dial): MeshMatcapMaterial with a matcap AND a map AND vertex colours, plus an optional felt fibre
// speckle whose strength is a UNIFORM (art/matcap's feltMaterial bakes the strength into the source: one program per
// strength). three.js keys programs on which features are present, so every surface here enables the same set:
//   - surfaces without a texture get a 1×1 white `map` (any UV, or none, samples white);
//   - unlit surfaces (room, décor, cloth, dial — formerly MeshBasicMaterial) get a 1×1 white `matcap`: matcap output
//     is diffuse × matcap texel, so white gives exactly MeshBasicMaterial's pixels;
//   - every geometry carries `normal` and a 3-component `color` attribute (white where there was none).
import { DataTexture, MeshMatcapMaterial, RGBAFormat, SRGBColorSpace, type Texture } from '@iwsdk/core';
import { MATCAPS, makeMatcap, type MatcapSpec } from '../art/matcap.js';

const KEY = 'env-surface-1';
let white: DataTexture | null = null;

/** Shared 1×1 white texture (map / matcap stand-in). */
export function whiteTexture(): DataTexture {
  if (!white) {
    white = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    white.colorSpace = SRGBColorSpace;
    white.needsUpdate = true;
  }
  return white;
}

/** Release the shared white texture (cafe.dispose). */
export function disposeSurfaceShared(): void {
  white?.dispose();
  white = null;
}

export interface SurfaceOpts {
  /** Matcap preset / spec; null = unlit (white matcap). */
  matcap?: keyof typeof MATCAPS | MatcapSpec | null;
  /** Colour texture (uv channel 0); omitted = white. */
  map?: Texture | null;
  /** Felt fibre speckle strength (0 = none; art/matcap felt uses 0.07). */
  fuzz?: number;
  color?: number;
  name?: string;
}

export function surfaceMaterial(o: SurfaceOpts = {}): MeshMatcapMaterial {
  const spec = o.matcap == null ? null : typeof o.matcap === 'string' ? MATCAPS[o.matcap] : o.matcap;
  const m = new MeshMatcapMaterial({
    matcap: spec ? makeMatcap(spec) : whiteTexture(),
    map: o.map ?? whiteTexture(),
    color: o.color ?? 0xffffff,
    vertexColors: true,
  });
  if (o.name) m.name = o.name;
  const fuzz = { value: Math.max(0, o.fuzz ?? 0) };
  m.userData.fuzz = fuzz;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFeltFuzz = fuzz;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFeltPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFeltPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFeltFuzz;\nvarying vec3 vFeltPos;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (uFeltFuzz > 0.0) {
          float feltN = fract(sin(dot(floor(vFeltPos * 1400.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          diffuseColor.rgb *= (1.0 - uFeltFuzz) + uFeltFuzz * 2.0 * feltN;
        }`,
      );
  };
  m.customProgramCacheKey = () => KEY;
  return m;
}
