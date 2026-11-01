// Two instanced "decal" batches shared by the whole café, each ONE draw call:
//  - GlowBatch: every additive glow (lamp halo + light pool, glints, flames, dwell rings, fairy lights, dust motes,
//    music notes, fuse sparks). Billboard / flat / upright modes, atlas cells, optional arc mask.
//  - BlobBatch: every contact-shadow blob (static furniture + moving props and gadgets). No shadow maps.
// Instances are rig-local; owners write slots each frame, sync() uploads once.
import {
  AdditiveBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  type Texture,
} from '@iwsdk/core';

export const MODE = { billboard: 0, flat: 1, upright: 2, pushed: 3 } as const;

const ATLAS_LOOKUP = /* glsl */ `
vec2 atlasUv(float cell, vec2 uv) {
  float col = mod(cell, 8.0);
  float row = floor(cell / 8.0 + 0.001);
  return vec2((col + uv.x) / 8.0, (1.0 - row + uv.y) / 2.0);
}`;

const GLOW_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec4 iColor;
attribute vec4 iParam; // cell, mode, rotation, arc
uniform vec3 uCam;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vCellArc;
void main() {
  vUv = uv;
  vColor = iColor;
  vCellArc = vec2(iParam.x, iParam.w);
  float cr = cos(iParam.z);
  float sr = sin(iParam.z);
  vec2 c = position.xy;
  vec2 q = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * iSize;
  vec4 mv;
  if (iParam.y < 0.5 || iParam.y > 2.5) {
    mv = modelViewMatrix * vec4(iPos, 1.0);
    if (iParam.y > 2.5) mv.xyz += normalize(-mv.xyz) * 0.75 * max(iSize.x, iSize.y);
    mv.xy += q;
  } else if (iParam.y < 1.5) {
    mv = modelViewMatrix * vec4(iPos + vec3(q.x, 0.0, -q.y), 1.0);
  } else {
    vec3 tc = uCam - iPos;
    vec2 h = vec2(tc.z, -tc.x);
    float hl = length(h);
    vec3 right = hl > 1e-5 ? vec3(h.x / hl, 0.0, h.y / hl) : vec3(1.0, 0.0, 0.0);
    mv = modelViewMatrix * vec4(iPos + right * q.x + vec3(0.0, q.y, 0.0), 1.0);
  }
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FS = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vCellArc;
${ATLAS_LOOKUP}
void main() {
  float a = texture2D(uAtlas, atlasUv(vCellArc.x, vUv)).r;
  float arc = vCellArc.y;
  if (arc < 0.999) {
    vec2 d = vUv - 0.5;
    float t = fract(atan(d.x, d.y) / 6.2831853 + 1.0);
    float on = 1.0 - smoothstep(arc - 0.006, arc + 0.006, t);
    float head = smoothstep(arc - 0.08, arc, t) * on;
    a *= mix(0.14, 1.0, on) * (1.0 + 1.5 * head);
  }
  gl_FragColor = vec4(vColor.rgb, a * vColor.a);
  #include <colorspace_fragment>
}`;

function quadGeometry(): InstancedBufferGeometry {
  const quad = new PlaneGeometry(1, 1);
  const geo = new InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  return geo;
}

function inst(arr: Float32Array, size: number): InstancedBufferAttribute {
  const a = new InstancedBufferAttribute(arr, size);
  a.setUsage(DynamicDrawUsage);
  return a;
}

export class GlowBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly geo: InstancedBufferGeometry;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly param: Float32Array;
  private readonly attrs: InstancedBufferAttribute[];
  private used = 0;
  private dirty = true;
  private warned = false;

  constructor(
    atlas: Texture,
    readonly capacity = 256,
  ) {
    this.geo = quadGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity * 2);
    this.color = new Float32Array(capacity * 4);
    this.param = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) this.param[i * 4 + 3] = 1;
    this.attrs = [inst(this.pos, 3), inst(this.size, 2), inst(this.color, 4), inst(this.param, 4)];
    this.geo.setAttribute('iPos', this.attrs[0]);
    this.geo.setAttribute('iSize', this.attrs[1]);
    this.geo.setAttribute('iColor', this.attrs[2]);
    this.geo.setAttribute('iParam', this.attrs[3]);
    this.geo.instanceCount = 0;
    const mat = new ShaderMaterial({
      name: 'env-glow',
      uniforms: { uAtlas: { value: atlas }, uCam: { value: new Vector3() } },
      vertexShader: GLOW_VS,
      fragmentShader: GLOW_FS,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.name = 'env-glow';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  /** Reserve a slot (build time). Returns -1 when full (writes to -1 are ignored). */
  alloc(): number {
    if (this.used >= this.capacity) {
      if (!this.warned) console.warn('[environment] GlowBatch is full');
      this.warned = true;
      return -1;
    }
    const i = this.used++;
    this.geo.instanceCount = this.used;
    return i;
  }

  set(
    i: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number,
    cell: number,
    mode: number = MODE.billboard,
    rot = 0,
    arc = 1,
  ): void {
    if (i < 0) return;
    const p = this.pos;
    const s = this.size;
    const c = this.color;
    const q = this.param;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    s[i * 2] = w;
    s[i * 2 + 1] = h;
    c[i * 4] = r;
    c[i * 4 + 1] = g;
    c[i * 4 + 2] = b;
    c[i * 4 + 3] = a;
    q[i * 4] = cell;
    q[i * 4 + 1] = mode;
    q[i * 4 + 2] = rot;
    q[i * 4 + 3] = arc;
    this.dirty = true;
  }

  hide(i: number): void {
    if (i < 0) return;
    if (this.size[i * 2] === 0 && this.size[i * 2 + 1] === 0) return;
    this.size[i * 2] = 0;
    this.size[i * 2 + 1] = 0;
    this.dirty = true;
  }

  /** Upload changed slots; `camLocal` = camera position in the batch's (rig-local) space. */
  sync(camLocal: Vector3): void {
    (this.mesh.material.uniforms.uCam.value as Vector3).copy(camLocal);
    if (!this.dirty) return;
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k];
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.used * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirty = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mesh.material.dispose();
  }
}

// ------------------------------------------------------------------------------------------------ blobs

const BLOB_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec3 iParam; // opacity, cell, rotation
varying vec2 vUv;
varying vec2 vOC;
void main() {
  vUv = uv;
  vOC = iParam.xy;
  float c = cos(iParam.z);
  float s = sin(iParam.z);
  vec2 q = position.xy * iSize;
  vec2 r = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(iPos + vec3(r.x, 0.0, -r.y), 1.0);
}`;

const BLOB_FS = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uColor;
varying vec2 vUv;
varying vec2 vOC;
${ATLAS_LOOKUP}
void main() {
  float a = texture2D(uAtlas, atlasUv(vOC.y, vUv)).r * vOC.x;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

export class BlobBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly geo: InstancedBufferGeometry;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly param: Float32Array;
  private readonly attrs: InstancedBufferAttribute[];
  private used = 0;
  private dirty = true;

  constructor(
    atlas: Texture,
    readonly capacity = 64,
    color: [number, number, number] = [0.035, 0.02, 0.015],
  ) {
    this.geo = quadGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity * 2);
    this.param = new Float32Array(capacity * 3);
    this.attrs = [inst(this.pos, 3), inst(this.size, 2), inst(this.param, 3)];
    this.geo.setAttribute('iPos', this.attrs[0]);
    this.geo.setAttribute('iSize', this.attrs[1]);
    this.geo.setAttribute('iParam', this.attrs[2]);
    this.geo.instanceCount = 0;
    const mat = new ShaderMaterial({
      name: 'env-blob',
      uniforms: { uAtlas: { value: atlas }, uColor: { value: new Vector3(...color) } },
      vertexShader: BLOB_VS,
      fragmentShader: BLOB_FS,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.name = 'env-blobs';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  alloc(): number {
    if (this.used >= this.capacity) return -1;
    const i = this.used++;
    this.geo.instanceCount = this.used;
    return i;
  }

  /** Flat blob centred at (x, y, z), sx × sz metres, rotated `rot` about +Y. cell: atlas blobRound / blobRect. */
  set(i: number, x: number, y: number, z: number, sx: number, sz: number, opacity: number, cell: number, rot = 0): void {
    if (i < 0) return;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.size[i * 2] = sx;
    this.size[i * 2 + 1] = sz;
    this.param[i * 3] = opacity;
    this.param[i * 3 + 1] = cell;
    this.param[i * 3 + 2] = rot;
    this.dirty = true;
  }

  hide(i: number): void {
    if (i < 0 || (this.size[i * 2] === 0 && this.param[i * 3] === 0)) return;
    this.size[i * 2] = 0;
    this.size[i * 2 + 1] = 0;
    this.param[i * 3] = 0;
    this.dirty = true;
  }

  sync(): void {
    if (!this.dirty) return;
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k];
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.used * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirty = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mesh.material.dispose();
  }
}
