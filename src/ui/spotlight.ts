// Gaze spotlight: a soft warm additive pool of light (~9 cm) lying on the tabletop under the gaze point.
// Procedural (no texture), one draw call, smoothly follows, fades out when the gaze leaves the table.
import { AdditiveBlending, Color, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import { L } from '../layout.js';
import { clamp, clamp01, damp } from './anim.js';
import { VS_UV, type UICtx } from './context.js';

const SIZE = 0.095; // diameter (m)
const LIFT = 0.0045; // above the cloth: clears the mat (tableY + 0.003) without z-fighting
const FOLLOW_RATE = 15; // 1/s

const FS = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float soft = 1.0 - smoothstep(0.0, 1.0, r);
  soft *= soft;
  // a faint theatrical rim so it reads as a spotlight, not a smudge
  float rim = smoothstep(0.58, 0.8, r) * (1.0 - smoothstep(0.8, 1.0, r));
  float core = exp(-r * r * 10.0);
  float shimmer = 0.92 + 0.08 * sin(uTime * 2.3 + r * 9.0);
  vec3 col = uColor * (soft * 0.62 + rim * 0.2) * shimmer + uCore * core * 0.22;
  gl_FragColor = vec4(col, uAlpha * (1.0 - smoothstep(0.96, 1.0, r)));
  #include <colorspace_fragment>
}`;

export class Spotlight {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly target = new Vector3();
  private readonly pos = new Vector3();
  private placed = false;
  private want = false;
  private strength = 1;
  private alpha = 0;

  constructor(private readonly ctx: UICtx) {
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mat = new ShaderMaterial({
      name: 'ui-spotlight',
      uniforms: {
        uColor: { value: new Color(PAL.lampWarm) },
        uCore: { value: new Color(0xfff3dc) },
        uAlpha: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: VS_UV,
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
    this.mesh.scale.setScalar(SIZE);
    ctx.root.add(this.mesh);
  }

  set(point: Vector3 | null, strength = 1): void {
    if (!point || !Number.isFinite(point.x + point.y + point.z)) {
      this.want = false;
      return;
    }
    const t = this.ctx.rig.toLocal(point, this.target);
    const halfW = L.table.width / 2 - 0.03;
    const zNear = L.table.centerZ + L.table.depth / 2 - 0.03;
    const zFar = L.table.centerZ - L.table.depth / 2 + 0.03;
    const onTable = t.y - L.tableY < 0.45 && Math.abs(t.x) < halfW + 0.05 && t.z < zNear + 0.05 && t.z > zFar - 0.05;
    t.set(clamp(t.x, -halfW, halfW), L.tableY + LIFT, clamp(t.z, zFar, zNear));
    this.want = onTable;
    this.strength = clamp01(strength);
    if (!this.placed) {
      this.pos.copy(t);
      this.placed = true;
    }
  }

  update(dt: number, time: number): void {
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    this.pos.lerp(this.target, k);
    this.alpha = damp(this.alpha, this.want ? this.strength : 0, this.want ? 9 : 7, dt);
    const visible = this.alpha > 0.004;
    this.mesh.visible = visible;
    if (!visible && !this.want) this.placed = false; // next appearance snaps instead of sliding in
    if (!visible) return;
    this.mesh.position.copy(this.pos);
    this.mesh.scale.setScalar(SIZE * (1 + 0.035 * Math.sin(time * 2.1)));
    this.mat.uniforms.uAlpha.value = this.alpha;
    this.mat.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
