// Shared state handed to every UI element. `root` sits at the rig origin with an identity transform, so
// every UI position is in RIG-LOCAL metres (layout.ts coordinates).
import type { Group, Vector3, World } from '@iwsdk/core';
import type { StageRig } from '../layout.js';

export interface UICtx {
  world: World;
  rig: StageRig;
  root: Group;
  /** Eye (camera) position in rig-local space, refreshed at the start of every UI update. */
  readonly eye: Vector3;
  /** Texture anisotropy for text seen at grazing angles (plaques, newspaper, posters). */
  anisotropy: number;
}

/** Plain vertex shader for quads that only need UVs (multiview-safe: uses three's per-view matrices). */
export const VS_UV = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
