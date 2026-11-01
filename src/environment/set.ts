// Assemble the static café: merge every bucket into ONE mesh per material, bake light into vertex colours,
// add the cloth, mat, night window and lamp beam, and register static glows + contact-shadow blobs.
// Draw calls: room, wood, brass, glossy, emissive, décor, cloth, mat, night pane, beam = 10.
import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  type BufferGeometry,
  type Material,
  type ShaderMaterial,
  type Texture,
} from '@iwsdk/core';
import { mergeParts, type Part } from '../art/geometry.js';
import { MATCAPS, makeMatcap, matcapMaterial } from '../art/matcap.js';
import type { BlobBatch, GlowBatch } from './glow.js';
import { lightAt } from './light.js';
import { CEIL, EXTRA_LIGHTS, FLOOR, newBuckets, type StaticGlow } from './set-common.js';
import { buildRoom } from './set-room.js';
import { LAMP_GLOWS, buildStage, clothGeometry, lampEmissiveColor, makeBeam, matGeometry } from './set-stage.js';
import { makeClothTexture, makeDecorTexture, makeMatTexture, makeWallpaperTexture } from './textures.js';
import { bakeColors, rng, smoothstep } from './util.js';

export interface LitMaterial {
  mat: MeshBasicMaterial | MeshMatcapMaterial;
  /** Colour multiplier at lamp level 0 (1 at full). */
  floor: number;
}

export interface SetResult {
  group: Group;
  lit: LitMaterial[];
  beam: Mesh<BufferGeometry, ShaderMaterial>;
  night: Mesh<BufferGeometry, ShaderMaterial>;
  glows: StaticGlow[];
  lampGlows: { halo: StaticGlow; core: StaticGlow; pool: StaticGlow };
  dispose(): void;
}

export function buildSet(glow: GlowBatch, blobs: BlobBatch, anisotropy: number): SetResult {
  const group = new Group();
  group.name = 'env-set';
  const b = newBuckets();
  const stageBlobs = buildStage(b);
  const room = buildRoom(b);
  const disposables: Array<{ dispose(): void }> = [];
  const tmp = new Color();

  const merged = (parts: Part[], keepUv: boolean): BufferGeometry => {
    const g = mergeParts(parts, { keepUv });
    for (const p of parts) p.geometry.dispose();
    return g;
  };
  const add = (name: string, geo: BufferGeometry, mat: Material) => {
    const m = new Mesh(geo, mat);
    m.name = name;
    m.matrixAutoUpdate = false;
    group.add(m);
    disposables.push(geo, mat);
    return m;
  };

  // --- room shell (wallpaper map × baked light, with soft corner occlusion)
  const roomGeo = bakeColors(merged(b.room, true), (x, y, z, nx, ny, nz, c) => {
    lightAt(x, y, z, nx, ny, nz, tmp, { tableShadow: true, extra: EXTRA_LIGHTS });
    const ao = (0.55 + 0.45 * smoothstep(0, 0.45, y - FLOOR)) * (0.7 + 0.3 * smoothstep(0, 0.5, CEIL - y));
    c.multiply(tmp).multiplyScalar(ao);
  });
  const wallpaper = makeWallpaperTexture(anisotropy);
  const roomMat = new MeshBasicMaterial({ map: wallpaper, vertexColors: true });
  add('env-room', roomGeo, roomMat);
  disposables.push(wallpaper);

  // --- matcap furniture buckets
  const woodGeo = bakeColors(merged(b.wood, false), (x, y, z, nx, ny, nz, c) => {
    lightAt(x, y, z, nx, ny, nz, tmp, { tableShadow: true, extra: EXTRA_LIGHTS });
    c.multiply(tmp);
  });
  const woodMat = matcapMaterial('wood');
  add('env-wood', woodGeo, woodMat);

  const metalBake = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Color) => {
    lightAt(x, y, z, nx, ny, nz, tmp, { tableShadow: true, extra: EXTRA_LIGHTS });
    c.r *= 0.22 + 0.78 * Math.min(1.2, tmp.r);
    c.g *= 0.22 + 0.78 * Math.min(1.2, tmp.g);
    c.b *= 0.22 + 0.78 * Math.min(1.2, tmp.b);
  };
  const brassMat = matcapMaterial('brass');
  add('env-brass', bakeColors(merged(b.brass, false), metalBake), brassMat);
  const glossyMat = matcapMaterial('glossy');
  add('env-glossy', bakeColors(merged(b.glossy, false), metalBake), glossyMat);

  // --- emissive bits (bulbs, lamp interior): unlit, not tone-mapped
  const lampCol = { r: 0, g: 0, b: 0 };
  const emiGeo = bakeColors(merged(b.emissive, false), (x, y, z, _nx, _ny, _nz, c) => {
    if (lampEmissiveColor(x, y, z, lampCol)) c.setRGB(lampCol.r, lampCol.g, lampCol.b);
  });
  const emissiveMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  add('env-emissive', emiGeo, emissiveMat);

  // --- décor atlas (chalkboard, clock, sign, labels)
  const decorTex = makeDecorTexture(anisotropy);
  const decorGeo = bakeColors(merged(b.decor, true), (x, y, z, nx, ny, nz, c) => {
    lightAt(x, y, z, nx, ny, nz, tmp, { extra: EXTRA_LIGHTS });
    c.r *= Math.max(0.42, tmp.r * 1.15);
    c.g *= Math.max(0.42, tmp.g * 1.15);
    c.b *= Math.max(0.46, tmp.b * 1.15);
  });
  const decorMat = new MeshBasicMaterial({ map: decorTex, vertexColors: true });
  add('env-decor', decorGeo, decorMat);
  disposables.push(decorTex);

  // --- gingham cloth (baked lamp falloff + low-frequency wrinkle shading)
  const clothTex = makeClothTexture(anisotropy);
  const r = rng(99);
  const wr: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 6; i++) wr.push([0.5 + r() * 2.0, 0.5 + r() * 2.0, r() * 6.28, 0.012 + r() * 0.012]);
  const clothGeo = bakeColors(clothGeometry(), (x, y, z, nx, ny, nz, c) => {
    lightAt(x, y, z, nx, ny, nz, tmp, { bounce: 0, window: 0.6 });
    let w = 1;
    for (const [fx, fz, ph, amp] of wr) w += amp * Math.sin(x * fx * 6.28 + z * fz * 6.28 + ph);
    c.copy(tmp).multiplyScalar(w * 0.9);
  });
  const clothMat = new MeshBasicMaterial({ map: clothTex, vertexColors: true });
  add('env-cloth', clothGeo, clothMat);
  disposables.push(clothTex);

  // --- velvet close-up mat
  const matTex = makeMatTexture(anisotropy);
  const matMat = new MeshMatcapMaterial({ matcap: makeMatcap(MATCAPS.velvet), map: matTex });
  const mat = add('mat', matGeometry(), matMat);
  mat.matrixAutoUpdate = true;
  disposables.push(matTex);

  // --- night window + lamp beam
  const night = room.windowPane;
  group.add(night);
  disposables.push(night.geometry, night.material);
  const beam = makeBeam();
  group.add(beam);
  disposables.push(beam.geometry, beam.material);

  for (const m of group.children) m.updateMatrix();

  // --- contact shadows
  for (const s of [...stageBlobs, ...room.blobs]) blobs.set(blobs.alloc(), s.x, s.y, s.z, s.sx, s.sz, s.opacity, s.cell, s.rot ?? 0);

  // --- static glows
  const mk = (g: Omit<StaticGlow, 'slot'>): StaticGlow => {
    const s: StaticGlow = { ...g, slot: glow.alloc() };
    glow.set(s.slot, s.x, s.y, s.z, s.size, s.size, s.r, s.g, s.b, s.a, s.cell, s.mode);
    return s;
  };
  const lampGlows = {
    pool: mk({ ...LAMP_GLOWS.pool, twinkle: 0, rate: 0, phase: 0, lampLinked: true }),
    halo: mk({ ...LAMP_GLOWS.halo, twinkle: 0, rate: 0, phase: 0, lampLinked: true }),
    core: mk({ ...LAMP_GLOWS.core, twinkle: 0, rate: 0, phase: 0, lampLinked: true }),
  };
  const glows = room.glows.map(mk);

  const lit: LitMaterial[] = [
    { mat: clothMat, floor: 0.3 },
    { mat: matMat, floor: 0.35 },
    { mat: woodMat, floor: 0.55 },
    { mat: brassMat, floor: 0.55 },
    { mat: glossyMat, floor: 0.6 },
    { mat: roomMat, floor: 0.75 },
    { mat: decorMat, floor: 0.75 },
    { mat: emissiveMat, floor: 0.3 },
  ];

  return {
    group,
    lit,
    beam,
    night,
    glows,
    lampGlows,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
