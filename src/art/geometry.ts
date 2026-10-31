// Geometry helpers (owned by the lead): bake flat vertex colours and merge many primitive parts into one
// geometry, so a whole puppet part or prop is ONE draw call with a vertexColors material.
import { BufferAttribute, Color, Euler, Matrix4, Quaternion, Vector3, type BufferGeometry } from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface Part {
  geometry: BufferGeometry;
  color: number;
  /** Optional transform baked into the vertices. */
  position?: [number, number, number];
  rotation?: [number, number, number]; // XYZ euler, radians
  scale?: [number, number, number] | number;
}

const tmpColor = new Color();
const tmpMatrix = new Matrix4();
const tmpEuler = new Euler();
const tmpQuat = new Quaternion();
const tmpPos = new Vector3();
const tmpScale = new Vector3();

/** Return the geometry with a flat `color` attribute (in place). */
export function tint<G extends BufferGeometry>(geometry: G, color: number): G {
  tmpColor.setHex(color);
  const n = geometry.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = tmpColor.r;
    arr[i * 3 + 1] = tmpColor.g;
    arr[i * 3 + 2] = tmpColor.b;
  }
  geometry.setAttribute('color', new BufferAttribute(arr, 3));
  return geometry;
}

/**
 * Merge parts into one vertex-coloured geometry. Keeps only position/normal/color (uv dropped unless `keepUv`
 * and every part has it) and normalises indexed-ness, so any mix of three primitives works.
 */
export function mergeParts(parts: Part[], opts: { keepUv?: boolean } = {}): BufferGeometry {
  const prepared = parts.map((p) => {
    let g = p.geometry.clone();
    if (p.position || p.rotation || p.scale !== undefined) {
      const s = p.scale ?? 1;
      tmpPos.set(...(p.position ?? [0, 0, 0]));
      tmpQuat.setFromEuler(tmpEuler.set(...(p.rotation ?? [0, 0, 0]), 'XYZ'));
      if (typeof s === 'number') tmpScale.setScalar(s);
      else tmpScale.set(...s);
      g.applyMatrix4(tmpMatrix.compose(tmpPos, tmpQuat, tmpScale));
    }
    tint(g, p.color);
    for (const name of Object.keys(g.attributes)) {
      if (name === 'position' || name === 'normal' || name === 'color') continue;
      if (name === 'uv' && opts.keepUv) continue;
      g.deleteAttribute(name);
    }
    if (g.index) g = g.toNonIndexed();
    return g;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('[mergeParts] geometries have incompatible attributes');
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
