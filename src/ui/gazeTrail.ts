// Ghost gaze trail: a flowing dotted trail of gold sparkles arcing from the current gaze point to the thing
// to look at, ending in a pulsing ring. The arc lives on the GPU (three control points as uniforms) → one
// draw call and zero per-frame buffer uploads.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Object3D,
} from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import { clamp01, damp } from './anim.js';
import type { UICtx } from './context.js';
import type { ManagedHint } from './glove.js';

const DOTS = 36;

const VS = /* glsl */ `
attribute vec2 aCorner;
attribute float aPhase;
attribute float aKind;
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform vec4 uAnim; // (time, dot size, alpha, -): per-frame scalars in one vector (no boxed uniform writes)
varying vec2 vUv;
varying float vA;
varying float vKind;
varying float vTw;
void main() {
  vec3 p;
  float size;
  float a;
  float uTime = uAnim.x;
  float uSize = uAnim.y;
  if (aKind < 0.5) {
    float t = fract(aPhase + uTime * 0.32);
    float it = 1.0 - t;
    p = it * it * uP0 + 2.0 * it * t * uP1 + t * t * uP2;
    float tw = 0.5 + 0.5 * sin(uTime * 8.0 + aPhase * 47.0);
    size = uSize * (0.55 + 0.5 * tw) * (0.7 + 0.5 * sin(3.14159 * t));
    a = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.86, 1.0, t));
    vTw = tw;
  } else {
    float pulse = fract(uTime * 0.85 + aPhase);
    p = uP2;
    size = uSize * (2.4 + 4.2 * pulse);
    a = (1.0 - pulse) * (1.0 - pulse);
    vTw = pulse;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += aCorner * size;
  gl_Position = projectionMatrix * mv;
  vUv = aCorner;
  vA = a;
  vKind = aKind;
}`;

const FS = /* glsl */ `
uniform vec3 uColor;
uniform vec4 uAnim;
varying vec2 vUv;
varying float vA;
varying float vKind;
varying float vTw;
void main() {
  float r = length(vUv);
  float a;
  float hot;
  if (vKind < 0.5) {
    float core = exp(-r * r * 9.0);
    float rays = pow(max(0.0, 1.0 - abs(vUv.x) * 5.0), 2.0) * max(0.0, 1.0 - abs(vUv.y))
               + pow(max(0.0, 1.0 - abs(vUv.y) * 5.0), 2.0) * max(0.0, 1.0 - abs(vUv.x));
    a = core + rays * (0.35 + 0.65 * vTw);
    hot = core;
  } else {
    a = smoothstep(0.72, 0.86, r) * (1.0 - smoothstep(0.86, 1.0, r)) * 0.9;
    hot = 0.0;
  }
  a *= vA * uAnim.z;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.55 * hot), a);
  #include <colorspace_fragment>
}`;

let sharedGeo: BufferGeometry | null = null;
function trailGeometry(): BufferGeometry {
  if (sharedGeo) return sharedGeo;
  const quads = DOTS + 2; // dots + two staggered destination rings
  const corner = new Float32Array(quads * 4 * 2);
  const phase = new Float32Array(quads * 4);
  const kind = new Float32Array(quads * 4);
  const pos = new Float32Array(quads * 4 * 3);
  const index: number[] = [];
  const C = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let q = 0; q < quads; q++) {
    const isRing = q >= DOTS;
    for (let v = 0; v < 4; v++) {
      const i = q * 4 + v;
      corner[i * 2] = C[v * 2];
      corner[i * 2 + 1] = C[v * 2 + 1];
      phase[i] = isRing ? (q - DOTS) * 0.5 : q / DOTS;
      kind[i] = isRing ? 1 : 0;
    }
    const b = q * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new BufferAttribute(corner, 2));
  g.setAttribute('aPhase', new BufferAttribute(phase, 1));
  g.setAttribute('aKind', new BufferAttribute(kind, 1));
  g.setIndex(index);
  sharedGeo = g;
  return g;
}

export function disposeTrailGeometry(): void {
  sharedGeo?.dispose();
  sharedGeo = null;
}

export class GazeTrailHint implements ManagedHint {
  dead = false;
  private readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly p0 = new Vector3();
  private readonly p1 = new Vector3();
  private readonly p2 = new Vector3();
  private readonly anim = new Vector4(0, 0.0078, 0, 0);
  private alpha = 0;
  private stopping = false;
  private time = 0;

  constructor(
    private readonly ctx: UICtx,
    private readonly from: () => Vector3,
    private readonly to: Object3D,
  ) {
    this.mat = new ShaderMaterial({
      name: 'ui-gaze-trail',
      uniforms: {
        uP0: { value: this.p0 },
        uP1: { value: this.p1 },
        uP2: { value: this.p2 },
        uAnim: { value: this.anim },
        uColor: { value: new Color(PAL.glintGold) },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new Mesh(trailGeometry(), this.mat);
    this.mesh.name = 'ui-hint-gaze';
    this.mesh.frustumCulled = false; // positions are computed in the shader
    this.mesh.renderOrder = 42;
    this.mesh.visible = false;
    ctx.root.add(this.mesh);
  }

  stop(): void {
    this.stopping = true;
  }

  update(dt: number): void {
    if (this.dead) return;
    this.time += dt;
    this.alpha = damp(this.alpha, this.stopping ? 0 : 1, this.stopping ? 14 : 5, dt);
    if (this.stopping && this.alpha < 0.01) {
      this.dead = true;
      this.mesh.visible = false;
      return;
    }
    let src: Vector3 | null = null;
    try {
      src = this.from();
    } catch {
      src = null;
    }
    const f = this.ctx.frame;
    if (src && Number.isFinite(src.x + src.y + src.z)) f.toLocal(src, this.p0);
    // the target's world matrix as the renderer left it (≤ 1 frame stale): no recomposition, no allocation
    f.objectLocal(this.to, this.p2);
    // arc up and over (clears the audience heads on the way to a gadget)
    const p0 = this.p0;
    const p2 = this.p2;
    const dx = p2.x - p0.x;
    const dy = p2.y - p0.y;
    const dz = p2.z - p0.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const p1 = this.p1;
    p1.x = (p0.x + p2.x) * 0.5;
    p1.y = Math.max(p0.y, p2.y) + 0.06 + 0.28 * d;
    p1.z = (p0.z + p2.z) * 0.5;
    // shrink the arc when the gaze is already nearly there
    const near = clamp01(d / 0.12);
    this.anim.x = this.time;
    this.anim.z = this.alpha * (0.35 + 0.65 * near);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mat.dispose();
  }
}
