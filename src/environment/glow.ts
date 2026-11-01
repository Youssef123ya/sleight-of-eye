// Two instanced "decal" batches shared by the whole café, each ONE draw call (both on the café's shared program,
// see shader.ts):
//  - GlowBatch: every additive glow (lamp halo + light pool, glints, flames, dwell rings, fairy lights, dust motes,
//    music notes, fuse sparks). Billboard / flat / upright / pushed modes, atlas cells, optional arc mask.
//  - BlobBatch: every contact-shadow blob (static furniture + moving props and gadgets). No shadow maps.
// Instances are rig-local; owners write slots each frame, sync() uploads once. Per-frame safe: slot writes go straight
// into one interleaved Float32Array and the upload is a whole-buffer bufferSubData (no update-range objects).
import {
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  DynamicDrawUsage,
  Vector3,
  type Texture,
} from '@iwsdk/core';
import { AdditiveBlending, KIND, NormalBlending, envShaderMaterial } from './shader.js';

/** 0 billboard, 1 flat on the XZ plane, 2 upright (yaws to the camera), 3 billboard pushed toward the camera,
 *  4 flat contact shadow (scale then rotate). */
export const MODE = { billboard: 0, flat: 1, upright: 2, pushed: 3, blob: 4 } as const;

// interleaved layout: pos(3) size(2) color(4) param(4: cell, mode, rotation, arc)
const STRIDE = 13;
const O_SIZE = 3;
const O_COLOR = 5;
const O_PARAM = 9;

class QuadBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  /** Interleaved instance data (STRIDE floats per slot). */
  readonly data: Float32Array;
  protected readonly buffer: InstancedInterleavedBuffer;
  protected readonly geo: InstancedBufferGeometry;
  protected used = 0;
  protected dirty = true;

  constructor(
    readonly capacity: number,
    mat: ShaderMaterial,
    name: string,
    renderOrder: number,
  ) {
    const quad = new PlaneGeometry(1, 1); // position + normal + uv (the shared program needs normals everywhere)
    const geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('normal', quad.getAttribute('normal'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + O_PARAM + 3] = 1; // arc = full
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    geo.setAttribute('iPos', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('iSize', new InterleavedBufferAttribute(this.buffer, 2, O_SIZE));
    geo.setAttribute('iColor', new InterleavedBufferAttribute(this.buffer, 4, O_COLOR));
    geo.setAttribute('iParam', new InterleavedBufferAttribute(this.buffer, 4, O_PARAM));
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false; // identity under the rig: nothing to recompose each frame
  }

  /** Reserve a slot (build time). Returns -1 when full (writes to -1 are ignored). */
  alloc(): number {
    if (this.used >= this.capacity) return -1;
    const i = this.used++;
    this.geo.instanceCount = this.used;
    return i;
  }

  hide(i: number): void {
    if (i < 0) return;
    const o = i * STRIDE;
    const d = this.data;
    if (d[o + O_SIZE] === 0 && d[o + O_SIZE + 1] === 0) return;
    d[o + O_SIZE] = 0;
    d[o + O_SIZE + 1] = 0;
    this.dirty = true;
  }

  protected upload(): void {
    if (!this.dirty) return;
    this.buffer.needsUpdate = true; // no update ranges: one whole-buffer bufferSubData, no garbage
    this.dirty = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mesh.material.dispose();
  }
}

/** A static glow the batch animates by itself (fairy lights, candle jar, lamp halo/pool). */
export interface AnimatedGlow {
  slot: number;
  size: number;
  a: number;
  /** 0 = steady; otherwise twinkle depth 0..1 at `rate` Hz with `phase`. */
  twinkle: number;
  rate: number;
  phase: number;
  cell: number;
}
/** A dust mote drifting around (x, y, z) with amplitudes (ax, ay, az). */
export interface MoteGlow {
  slot: number;
  x: number;
  y: number;
  z: number;
  ax: number;
  ay: number;
  az: number;
  ph: number;
  rate: number;
}

export class GlowBatch extends QuadBatch {
  private readonly cam: Vector3;
  private warned = false;
  private lampGlows: AnimatedGlow[] = [];
  private twinkles: AnimatedGlow[] = [];
  private motes: MoteGlow[] = [];
  private flameCell = -1;
  /** Inputs of animate(), written as fields by the café (no boxed call arguments). */
  animNow = 0;
  animLamp = 1;

  /**
   * Hand the batch its self-animated slots: lamp glows breathe and follow the lamp level, twinkles flicker
   * (`flameCell` ones as candle flames), motes drift. animate() then runs them in ONE loop with no per-slot calls
   * (per-slot calls would box every double argument whenever V8 does not inline them).
   */
  setAnimated(lamp: AnimatedGlow[], twinkles: AnimatedGlow[], motes: MoteGlow[], flameCell: number): void {
    this.lampGlows = lamp;
    this.twinkles = twinkles;
    this.motes = motes;
    this.flameCell = flameCell;
  }

  /** Per frame: breathe / twinkle / drift the self-animated slots at `animNow` with lamp level `animLamp`. */
  animate(): void {
    const now = this.animNow;
    const lampK = this.animLamp;
    const d = this.data;
    const breathe = 1 + 0.015 * Math.sin(now * 1.3);
    const lamp = this.lampGlows;
    for (let i = 0; i < lamp.length; i++) {
      const s = lamp[i];
      if (s.slot < 0) continue;
      const o = s.slot * STRIDE;
      const sz = s.size * breathe;
      d[o + 3] = sz;
      d[o + 4] = sz;
      d[o + 8] = s.a * lampK;
    }
    const tw = this.twinkles;
    for (let i = 0; i < tw.length; i++) {
      const s = tw[i];
      if (s.slot < 0) continue;
      const o = s.slot * STRIDE;
      const t = 1 - s.twinkle * (0.5 + 0.5 * Math.sin(now * s.rate * 6.283185307179586 + s.phase));
      if (s.cell === this.flameCell) {
        d[o + 3] = s.size * 0.55;
        d[o + 4] = s.size * (0.85 + 0.15 * Math.sin(now * 23 + s.phase));
      } else {
        d[o + 3] = s.size;
        d[o + 4] = s.size;
      }
      d[o + 8] = s.a * t;
    }
    const motes = this.motes;
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i];
      if (m.slot < 0) continue;
      const o = m.slot * STRIDE;
      const t = now * m.rate + m.ph;
      const sparkle = Math.max(0, Math.sin(now * (0.6 + m.rate * 2) + m.ph * 3));
      d[o] = m.x + Math.sin(t * 1.3) * m.ax;
      d[o + 1] = m.y + Math.sin(t * 0.9 + 1.7) * m.ay;
      d[o + 2] = m.z + Math.cos(t * 1.1) * m.az;
      d[o + 8] = (0.12 + 0.6 * sparkle * sparkle * sparkle) * lampK;
    }
    this.dirty = true;
  }

  constructor(atlas: Texture, capacity = 256) {
    const cam = new Vector3();
    super(
      capacity,
      envShaderMaterial({
        name: 'env-glow',
        kind: KIND.batch,
        uniforms: { uAtlas: { value: atlas }, uCam: { value: cam }, uShade: { value: 0 } },
        blending: AdditiveBlending,
      }),
      'env-glow',
      20,
    );
    this.cam = cam;
  }

  override alloc(): number {
    const i = super.alloc();
    if (i < 0 && !this.warned) {
      console.warn('[environment] GlowBatch is full');
      this.warned = true;
    }
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
    const d = this.data;
    const o = i * STRIDE;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = w;
    d[o + 4] = h;
    d[o + 5] = r;
    d[o + 6] = g;
    d[o + 7] = b;
    d[o + 8] = a;
    d[o + 9] = cell;
    d[o + 10] = mode;
    d[o + 11] = rot;
    d[o + 12] = arc;
    this.dirty = true;
  }

  /** Move a slot without touching its look (per-frame drift). */
  setPos(i: number, x: number, y: number, z: number): void {
    if (i < 0) return;
    const d = this.data;
    const o = i * STRIDE;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    this.dirty = true;
  }

  /** Position + alpha only (per-frame drift with a fixed look). */
  setPosAlpha(i: number, x: number, y: number, z: number, a: number): void {
    if (i < 0) return;
    const d = this.data;
    const o = i * STRIDE;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 8] = a;
    this.dirty = true;
  }

  /** Size + alpha only (per-frame twinkle / breathing). */
  setSizeAlpha(i: number, w: number, h: number, a: number): void {
    if (i < 0) return;
    const d = this.data;
    const o = i * STRIDE;
    d[o + 3] = w;
    d[o + 4] = h;
    d[o + 8] = a;
    this.dirty = true;
  }

  /** Upload changed slots; `camLocal` = camera position in the batch's (rig-local) space. */
  sync(camLocal: Vector3): void {
    const c = this.cam;
    c.x = camLocal.x;
    c.y = camLocal.y;
    c.z = camLocal.z;
    this.upload();
  }
}

/** Contact-shadow colour (linear): warm near-black. */
const BLOB_RGB = [0.035, 0.02, 0.015] as const;

export class BlobBatch extends QuadBatch {
  constructor(atlas: Texture, capacity = 64) {
    super(
      capacity,
      envShaderMaterial({
        name: 'env-blob',
        kind: KIND.batch,
        uniforms: { uAtlas: { value: atlas }, uCam: { value: new Vector3() }, uShade: { value: 0 } },
        blending: NormalBlending,
        polygonOffset: true,
      }),
      'env-blobs',
      10,
    );
  }

  /** Flat blob centred at (x, y, z), sx × sz metres, rotated `rot` about +Y. cell: atlas blobRound / blobRect. */
  set(i: number, x: number, y: number, z: number, sx: number, sz: number, opacity: number, cell: number, rot = 0): void {
    if (i < 0) return;
    const d = this.data;
    const o = i * STRIDE;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = sx;
    d[o + 4] = sz;
    d[o + 5] = BLOB_RGB[0];
    d[o + 6] = BLOB_RGB[1];
    d[o + 7] = BLOB_RGB[2];
    d[o + 8] = opacity;
    d[o + 9] = cell;
    d[o + 10] = MODE.blob;
    d[o + 11] = rot;
    d[o + 12] = 1;
    this.dirty = true;
  }

  override hide(i: number): void {
    if (i < 0) return;
    const o = i * STRIDE;
    const d = this.data;
    if (d[o + O_SIZE] === 0 && d[o + O_COLOR + 3] === 0) return;
    d[o + O_SIZE] = 0;
    d[o + O_SIZE + 1] = 0;
    d[o + O_COLOR + 3] = 0;
    this.dirty = true;
  }

  sync(): void {
    this.upload();
  }
}
