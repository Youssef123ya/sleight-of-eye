// Procedural matcap materials (owned by the lead): cheap, stylised, multiview-safe, no lights needed.
// MeshMatcapMaterial samples a lit-sphere texture by view-space normal; with vertexColors the vertex colour
// multiplies the (mostly neutral, warm-lit) matcap, so one material serves every felt colour.
import { CanvasTexture, Color, MeshMatcapMaterial, SRGBColorSpace } from '@iwsdk/core';

export interface MatcapSpec {
  /** Unlit/ambient shade (0..1 grey or hex colour). */
  base: number;
  /** Key light colour (warm lamp from upper-left-front). */
  key: number;
  keyStrength: number;
  /** Rim/sheen colour and strength (felt fuzz, velvet). */
  rim: number;
  rimStrength: number;
  rimPower: number;
  /** Sharp specular dot (glossy button eyes, brass). 0 = none. */
  spec: number;
  specSize: number; // 0..1, smaller = tighter
}

const cache = new Map<string, CanvasTexture>();

function hexToRgb(h: number): [number, number, number] {
  const c = new Color(h);
  return [c.r, c.g, c.b];
}

export function makeMatcap(spec: MatcapSpec, size = 256): CanvasTexture {
  const key = JSON.stringify(spec) + size;
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const base = hexToRgb(spec.base);
  const keyC = hexToRgb(spec.key);
  const rimC = hexToRgb(spec.rim);
  // light directions in view space (x right, y up, z toward viewer)
  const kx = -0.45, ky = 0.62, kz = 0.64;
  const sx = -0.38, sy = 0.5, sz = 0.78; // specular highlight direction
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size * 2 - 1;
      const y = 1 - (j + 0.5) / size * 2;
      const r2 = x * x + y * y;
      const o = (j * size + i) * 4;
      if (r2 > 1) {
        img.data[o + 3] = 0;
        continue;
      }
      const z = Math.sqrt(1 - r2);
      const lambert = Math.max(0, x * kx + y * ky + z * kz);
      const wrap = (lambert + 0.35) / 1.35; // soft wrap lighting reads as fabric
      const rim = Math.pow(1 - z, spec.rimPower) * spec.rimStrength;
      const sd = Math.max(0, x * sx + y * sy + z * sz);
      const specular = spec.spec > 0 ? Math.pow(sd, 2 + (1 - spec.specSize) * 300) * spec.spec : 0;
      for (let c = 0; c < 3; c++) {
        const v = base[c] * (0.55 + 0.45 * wrap) + keyC[c] * spec.keyStrength * lambert * lambert + rimC[c] * rim + specular;
        img.data[o + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

export const MATCAPS = {
  felt: {
    base: 0xbdb3a6, key: 0xffd9a0, keyStrength: 0.35, rim: 0xfff1dc, rimStrength: 0.45, rimPower: 2.2, spec: 0, specSize: 0,
  },
  glossy: {
    base: 0x9a9aa4, key: 0xfff0d8, keyStrength: 0.25, rim: 0x8fa0ff, rimStrength: 0.15, rimPower: 3, spec: 1.6, specSize: 0.12,
  },
  brass: {
    base: 0x7a5a24, key: 0xffe08a, keyStrength: 0.9, rim: 0xffd27a, rimStrength: 0.5, rimPower: 2.5, spec: 1.2, specSize: 0.25,
  },
  velvet: {
    base: 0x6f8a7a, key: 0xffd9a0, keyStrength: 0.15, rim: 0xc8ffd8, rimStrength: 0.7, rimPower: 1.6, spec: 0, specSize: 0,
  },
  wood: {
    base: 0xb59a86, key: 0xffd9a0, keyStrength: 0.45, rim: 0xffe8cc, rimStrength: 0.15, rimPower: 3, spec: 0.25, specSize: 0.5,
  },
} satisfies Record<string, MatcapSpec>;

/**
 * Felt: vertex-coloured matcap with a fine object-space fibre speckle (no view-dependent noise, so it does not
 * swim and stays multiview-safe). Pass `{ vertexColors: true }` geometry; one shared instance per look.
 */
export function feltMaterial(opts: { color?: number; fuzz?: number; vertexColors?: boolean } = {}): MeshMatcapMaterial {
  const m = new MeshMatcapMaterial({
    matcap: makeMatcap(MATCAPS.felt),
    color: opts.color ?? 0xffffff,
    vertexColors: opts.vertexColors ?? true,
  });
  const fuzz = (opts.fuzz ?? 0.07).toFixed(3);
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFeltPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFeltPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFeltPos;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float feltN = fract(sin(dot(floor(vFeltPos * 1400.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        diffuseColor.rgb *= (1.0 - ${fuzz}) + ${fuzz} * 2.0 * feltN;`,
      );
  };
  m.customProgramCacheKey = () => `felt-${fuzz}`;
  return m;
}

/** Generic matcap material from a preset (vertex colours on by default). */
export function matcapMaterial(
  preset: keyof typeof MATCAPS,
  opts: { color?: number; vertexColors?: boolean; transparent?: boolean; opacity?: number } = {},
): MeshMatcapMaterial {
  return new MeshMatcapMaterial({
    matcap: makeMatcap(MATCAPS[preset]),
    color: opts.color ?? 0xffffff,
    vertexColors: opts.vertexColors ?? true,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
}
