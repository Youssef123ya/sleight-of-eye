// Gaze spotlight: a soft warm additive pool of light (~9.5 cm) lying on the stage under the gaze point.
// The velvet mat is 6 mm thick, so the decal is DRAPED: a fine grid whose height is computed per vertex in the
// shader — 1.5 mm above the mat top over the mat (rounded-rectangle distance field), easing down to 1.5 mm above
// the cloth just past the mat edge — so the pool glides across the mat and spills over its edge onto the cloth.
// Procedural (no texture), one draw call, zero per-frame uploads, allocation-free; fades when the gaze leaves.
import { AdditiveBlending, Color, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4 } from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import { L } from '../layout.js';
import { clamp, clamp01, damp } from './anim.js';
import type { UICtx } from './context.js';

const SIZE = 0.095; // diameter (m)
const HOVER = 0.0015; // above whichever surface is under it (mat top or cloth)
const DRAPE = 0.012; // horizontal run (m) of the ease from the mat top down to the cloth past the mat edge
const MAT_CORNER = 0.012; // the café mat's rounded corners (environment set-stage matGeometry)
const GRID = 32; // decal subdivisions (≈ 3 mm cells: the drape is ≥ 4 cells wide)
const FOLLOW_RATE = 15; // 1/s
const MAT_HALF_X = L.mat.size[0] / 2;
const MAT_HALF_Z = L.mat.size[1] / 2;

// uAnim = (diameter, alpha, time, -): per-frame scalars live in one vector so a frame writes plain fields
// (assigning a number to a uniform's `value` boxes it on every write)
const VS = /* glsl */ `
uniform vec3 uCenter;
uniform vec4 uAnim;
uniform vec2 uMatC;
uniform vec2 uMatHalf;
uniform float uMatR;
uniform float uMatY;
uniform float uClothY;
uniform float uDrape;
varying vec2 vUv;
varying float vOnMat;
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vUv = uv;
  vec2 xz = uCenter.xz + position.xz * uAnim.x;
  float k = smoothstep(0.0, uDrape, sdRoundRect(xz - uMatC, uMatHalf, uMatR));
  vOnMat = 1.0 - k;
  vec3 p = vec3(xz.x, mix(uMatY, uClothY, k), xz.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FS = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform vec4 uAnim;
varying vec2 vUv;
varying float vOnMat;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float soft = 1.0 - smoothstep(0.0, 1.0, r);
  soft *= soft;
  // a faint theatrical rim so it reads as a spotlight, not a smudge
  float rim = smoothstep(0.58, 0.8, r) * (1.0 - smoothstep(0.8, 1.0, r));
  float core = exp(-r * r * 10.0);
  float shimmer = 0.92 + 0.08 * sin(uAnim.z * 2.3 + r * 9.0);
  // the dark velvet takes a touch more light so the pool reads as strongly there as on the cream cloth
  float gain = 1.0 + 0.3 * vOnMat;
  vec3 col = (uColor * (soft * 0.62 + rim * 0.2) * shimmer + uCore * core * 0.22) * gain;
  gl_FragColor = vec4(col, uAnim.y * (1.0 - smoothstep(0.96, 1.0, r)));
  #include <colorspace_fragment>
}`;

export class Spotlight {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly center: Vector3;
  private readonly anim = new Vector4(SIZE, 0, 0, 0);
  private readonly local = new Vector3();
  private tx = 0;
  private tz = 0;
  private px = 0;
  private pz = 0;
  private placed = false;
  private want = false;
  private strength = 1;
  private alpha = 0;

  constructor(private readonly ctx: UICtx) {
    const geo = new PlaneGeometry(1, 1, GRID, GRID);
    geo.rotateX(-Math.PI / 2);
    this.center = new Vector3(0, L.mat.top, L.mat.center[2]);
    this.mat = new ShaderMaterial({
      name: 'ui-spotlight',
      uniforms: {
        uCenter: { value: this.center },
        uAnim: { value: this.anim },
        uMatC: { value: new Vector2(L.mat.center[0], L.mat.center[2]) },
        uMatHalf: { value: new Vector2(MAT_HALF_X, MAT_HALF_Z) },
        uMatR: { value: MAT_CORNER },
        uMatY: { value: L.mat.top + HOVER },
        uClothY: { value: L.tableY + HOVER },
        uDrape: { value: DRAPE },
        uColor: { value: new Color(PAL.lampWarm) },
        uCore: { value: new Color(0xfff3dc) },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.name = 'ui-spotlight';
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false; // vertices are placed in the shader (rig-local), the mesh stays at the origin
    ctx.root.add(this.mesh);
  }

  /** World gaze point (null hides). Called by the gaze tracker whenever the point moves: allocation-free. */
  set(point: Vector3 | null, strength = 1): void {
    if (!point || !Number.isFinite(point.x + point.y + point.z)) {
      this.want = false;
      return;
    }
    const f = this.ctx.frame;
    f.sync(); // the gaze calls this before ui.update(): see a recalibration in its very first frame
    const t = f.toLocal(point, this.local);
    let x = t.x;
    let z = t.z;
    // Table hits arrive on the cloth plane (y = tableY), but over the mat the line of sight meets the velvet 6 mm
    // higher: slide the point back along the eye ray onto the mat top so the pool sits exactly where you look.
    // (Focused targets — a coin, a cup — keep their own x/z: the pool lies under them.)
    if (Math.abs(t.y - L.tableY) < 0.001) {
      const e = this.ctx.eye;
      const dy = t.y - e.y;
      if (dy < -0.01) {
        const k = (L.mat.top - e.y) / dy;
        const mx = e.x + (x - e.x) * k;
        const mz = e.z + (z - e.z) * k;
        if (Math.abs(mx - L.mat.center[0]) <= MAT_HALF_X && Math.abs(mz - L.mat.center[2]) <= MAT_HALF_Z) {
          x = mx;
          z = mz;
        }
      }
    }
    const halfW = L.table.width / 2 - 0.03;
    const zNear = L.table.centerZ + L.table.depth / 2 - 0.03;
    const zFar = L.table.centerZ - L.table.depth / 2 + 0.03;
    this.want = t.y - L.tableY < 0.45 && Math.abs(x) < halfW + 0.05 && z < zNear + 0.05 && z > zFar - 0.05;
    this.tx = clamp(x, -halfW, halfW);
    this.tz = clamp(z, zFar, zNear);
    this.strength = clamp01(strength);
    if (!this.placed) {
      this.px = this.tx;
      this.pz = this.tz;
      this.placed = true;
    }
  }

  /** Forget the pool (next appearance fades in where the gaze is instead of sliding in from the last spot). */
  reset(): void {
    this.want = false;
    this.alpha = 0;
    this.placed = false;
    this.mesh.visible = false;
  }

  update(dt: number, time: number): void {
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    this.px += (this.tx - this.px) * k;
    this.pz += (this.tz - this.pz) * k;
    this.alpha = damp(this.alpha, this.want ? this.strength : 0, this.want ? 9 : 7, dt);
    const visible = this.alpha > 0.004;
    this.mesh.visible = visible;
    if (!visible && !this.want) this.placed = false; // next appearance snaps instead of sliding in
    if (!visible) return;
    const c = this.center;
    c.x = this.px;
    c.z = this.pz;
    const a = this.anim;
    a.x = SIZE * (1 + 0.035 * Math.sin(time * 2.1));
    a.y = this.alpha;
    a.z = time;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
