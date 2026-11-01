// Rewind smear: ~0.5 s of cool tape-rewind streaks racing right→left across the stage, a soft scan band and a
// faint ◀◀ glyph, under one smooth envelope (no flashing). One additive quad, drawn over the stage.
import { AdditiveBlending, Color, Mesh, PlaneGeometry, ShaderMaterial } from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import { L } from '../layout.js';
import { clamp01, deferred, type Deferred } from './anim.js';
import { VS_UV, type UICtx } from './context.js';

const DURATION = 0.55;

const FS = /* glsl */ `
uniform float uT;
uniform float uAmp;
uniform vec3 uCool;
uniform vec3 uWarm;
varying vec2 vUv;
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  // tape wobble
  float wob = sin(uv.x * 18.0 + uT * 40.0) * 0.004;
  float band = floor((uv.y + wob) * 46.0);
  float r = hash(band);
  float r2 = hash(band + 17.0);
  float speed = 2.2 + 3.5 * r;
  float x = fract(uv.x * (0.8 + r2 * 1.4) + uT * speed + r * 3.0);
  float streak = smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.05, 0.6 + 0.3 * r2, x));
  streak *= step(0.42, r);                      // only some bands carry a streak
  float rowFade = 0.5 + 0.5 * sin(fract((uv.y + wob) * 46.0) * 3.14159);
  // scan band sweeping right → left with a chromatic fringe
  float sx = 1.15 - uT * 1.3;
  float d = uv.x - sx;
  float scan = exp(-d * d * 520.0);
  float fringeA = exp(-(d - 0.02) * (d - 0.02) * 900.0);
  float fringeB = exp(-(d + 0.02) * (d + 0.02) * 900.0);
  // soft ◀◀ glyph in the middle (two anti-aliased triangles pointing left)
  vec2 g = (uv - vec2(0.5, 0.56)) * vec2(2.6, 4.0);
  float aa = 0.025;
  float t1 = smoothstep(-aa, aa, (g.x + 0.22) * 0.85 - abs(g.y)) * smoothstep(-aa, aa, 0.0 - g.x) * smoothstep(-aa, aa, g.x + 0.22);
  float t2 = smoothstep(-aa, aa, g.x * 0.85 - abs(g.y)) * smoothstep(-aa, aa, 0.22 - g.x) * smoothstep(-aa, aa, g.x);
  float glyph = (t1 + t2) * 0.32;
  vec3 col = uCool * streak * rowFade * 0.75
           + uWarm * scan * 0.3
           + vec3(0.25, 0.75, 1.0) * fringeA * 0.35
           + vec3(1.0, 0.35, 0.7) * fringeB * 0.25
           + vec3(0.85, 0.95, 1.0) * glyph;
  float edge = smoothstep(0.0, 0.14, uv.x) * (1.0 - smoothstep(0.86, 1.0, uv.x))
             * smoothstep(0.0, 0.16, uv.y) * (1.0 - smoothstep(0.84, 1.0, uv.y));
  gl_FragColor = vec4(col, uAmp * edge);
  #include <colorspace_fragment>
}`;

export class RewindSmear {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private t = 1;
  private pending: Deferred | null = null;

  constructor(ctx: UICtx) {
    this.mat = new ShaderMaterial({
      name: 'ui-rewind',
      uniforms: {
        uT: { value: 0 },
        uAmp: { value: 0 },
        uCool: { value: new Color(PAL.glintBlue) },
        uWarm: { value: new Color(PAL.lampWarm) },
      },
      vertexShader: VS_UV,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(0.86, 0.46), this.mat);
    this.mesh.name = 'ui-rewind';
    this.mesh.position.set(0, L.tableY + 0.13, -0.47);
    this.mesh.rotation.x = -0.18; // lean back a touch, toward the eye
    this.mesh.renderOrder = 60;
    this.mesh.visible = false;
    ctx.root.add(this.mesh);
  }

  play(): Promise<void> {
    this.pending?.resolve();
    this.pending = deferred();
    this.t = 0;
    this.mesh.visible = true;
    return this.pending.promise;
  }

  update(dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / DURATION);
    const env = Math.sin(Math.PI * clamp01(this.t)); // one smooth swell, never a strobe
    this.mat.uniforms.uT.value = this.t;
    this.mat.uniforms.uAmp.value = env * 0.85;
    if (this.t >= 1) {
      this.mesh.visible = false;
      this.pending?.resolve();
      this.pending = null;
    }
  }

  dispose(): void {
    this.pending?.resolve();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
