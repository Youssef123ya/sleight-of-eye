// Red velvet theatre curtain across the front of the riser: two pleated traveller panels that slide in from
// the wings (and bunch up as they leave) plus a swagged valance with gold fringe. Hides the audience and the
// gadgets, never the mat. Everything is computed in one vertex shader → one opaque draw call, hidden when open.
import { BufferAttribute, BufferGeometry, Mesh, ShaderMaterial, Vector3 } from '@iwsdk/core';
import type { Cafe } from '../contracts.js';
import { L } from '../layout.js';
import { clamp01, deferred, easeInOutCubic, type Deferred } from './anim.js';
import type { UICtx } from './context.js';

const Z = -0.572; // just in front of the riser (front edge at -0.60), behind the mat (far edge -0.52)
const WIDTH = 1.04;
const HEIGHT = 0.36; // tabletop → just above eye level from the player's angle
const VAL_H = 0.085;
const NX = 72;
const NY = 8;
const NV = 140;

const VS = /* glsl */ `
attribute vec2 aUV;
attribute float aSide;
attribute float aKind;
uniform float uOpen;
uniform float uDrop;
uniform float uTime;
uniform float uSway;
uniform vec3 uBase;
uniform float uWidth;
uniform float uHeight;
uniform float uValH;
varying vec2 vUV;
varying float vKind;
varying vec3 vN;
varying vec3 vView;
varying float vX;
varying float vFringe;
const float PLEATS = 7.0;
const float TAU = 6.2831853;
void main() {
  vec3 p;
  vec3 n;
  float u = aUV.x;
  float v = aUV.y;
  vFringe = 0.0;
  if (aKind < 0.5) {
    float halfW = uWidth * 0.5;
    // the leading edge (u = 1) travels first; the outer edge follows
    float o = clamp(uOpen * 1.18 - (1.0 - u) * 0.18, 0.0, 1.0);
    o = o * o * (3.0 - 2.0 * o);
    float spreadX = mix(halfW + 0.02, -0.014, u);
    float gatherX = halfW + 0.42 - u * 0.075;
    float x = mix(spreadX, gatherX, o);
    float dxdu = mix(-(halfW + 0.034), -0.075, o);
    float amp = mix(0.0085, 0.024, o) * (0.8 + 0.2 * v);
    float ph = u * PLEATS * TAU + aSide * 0.9;
    float z = amp * sin(ph);
    float dzdu = amp * PLEATS * TAU * cos(ph);
    float hem = (1.0 - v) * (1.0 - v);
    float sway = uSway * hem * sin(uTime * 5.2 + u * 5.0 + aSide);
    z += sway;
    p = uBase + vec3(aSide * x, v * uHeight, z);
    float slope = dzdu / (dxdu * aSide);
    n = normalize(vec3(-slope, 0.0, 1.0));
    vX = aSide * x;
  } else {
    float xw = uWidth + 0.08;
    float x = (u - 0.5) * xw;
    // swags: each one dips in the middle; v = 0 is the scalloped hem
    float sw = fract(u * 6.0);
    float dip = sin(3.14159 * sw);
    float y0 = uHeight - 0.012 - 0.026 * dip;
    float y = mix(y0, uHeight + uValH, v);
    float lift = (1.0 - uDrop) * 0.32;
    float z = 0.012 + 0.01 * dip * (1.0 - v);
    p = uBase + vec3(x, y + lift, z);
    n = normalize(vec3(0.0, -0.35 * dip * (1.0 - v), 1.0));
    vX = x;
    vFringe = sw;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vView = -mv.xyz;
  vN = normalize(normalMatrix * n);
  vUV = aUV;
  vKind = aKind;
}`;

const FS = /* glsl */ `
uniform float uLampX;
varying vec2 vUV;
varying float vKind;
varying vec3 vN;
varying vec3 vView;
varying float vX;
varying float vFringe;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vView);
  vec3 lightDir = normalize(vec3(-0.25, 0.55, 0.8));
  float diff = max(dot(n, lightDir), 0.0);
  float ndv = abs(dot(n, v));
  vec3 velvet = vec3(0.42, 0.02, 0.045);
  vec3 col = velvet * (0.28 + 0.95 * diff);
  col += vec3(0.85, 0.18, 0.22) * pow(1.0 - ndv, 2.6) * 0.45;      // velvet sheen at grazing angles
  float alpha = 1.0;
  if (vKind < 0.5) {
    float v0 = vUV.y;
    col *= mix(0.55, 1.0, smoothstep(0.0, 0.3, v0));                  // shadowed hem
    col *= mix(1.0, 0.7, smoothstep(0.82, 1.0, v0));                  // under the valance
    col *= 1.0 + 0.55 * exp(-vX * vX / 0.05) * smoothstep(0.75, 0.0, v0); // the table lamp's warm spill
    // gold trim: leading edge braid + hem band
    float edge = smoothstep(0.972, 0.985, vUV.x);
    float hemBand = 1.0 - smoothstep(0.03, 0.042, v0);
    float trim = max(edge, hemBand);
    float braid = 0.75 + 0.25 * sin((vUV.x * 900.0 + v0 * 400.0));
    vec3 gold = vec3(0.95, 0.66, 0.22) * (0.45 + 0.75 * diff) * braid;
    col = mix(col, gold, trim);
  } else {
    // valance: deeper velvet, gold braid line, fringe of tassels along the swags
    col *= 0.85;
    float braidLine = smoothstep(0.22, 0.26, vUV.y) * (1.0 - smoothstep(0.3, 0.34, vUV.y));
    float topLine = smoothstep(0.86, 0.9, vUV.y) * (1.0 - smoothstep(0.94, 0.98, vUV.y));
    vec3 gold = vec3(0.95, 0.68, 0.24) * (0.5 + 0.7 * diff);
    col = mix(col, gold, max(braidLine, topLine) * (0.8 + 0.2 * sin(vUV.x * 1400.0)));
    float fringeZone = 1.0 - smoothstep(0.1, 0.16, vUV.y);
    float strands = 0.5 + 0.5 * sin(vUV.x * 2600.0);
    col = mix(col, gold * (0.6 + 0.4 * strands), fringeZone);
    // tassel tips: alpha-to-coverage cut along the hem
    alpha = mix(1.0, smoothstep(0.25, 0.6, strands + vUV.y * 6.0), fringeZone);
  }
  #if defined( TONE_MAPPING )
    col = toneMapping(col);
  #endif
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}`;

function buildGeometry(): BufferGeometry {
  const uvs: number[] = [];
  const side: number[] = [];
  const kind: number[] = [];
  const index: number[] = [];
  let base = 0;
  const grid = (nx: number, ny: number, s: number, k: number) => {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        uvs.push(i / nx, j / ny);
        side.push(s);
        kind.push(k);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        // keep the front face (+Z, toward the player) counter-clockwise: x grows with u for the left
        // panel and the valance, but shrinks with u for the right panel (mirrored)
        if (s > 0) index.push(a, c, b, b, c, d);
        else index.push(a, b, c, b, d, c);
      }
    }
    base += (nx + 1) * (ny + 1);
  };
  grid(NX, NY, -1, 0);
  grid(NX, NY, 1, 0);
  grid(NV, 1, 0, 1);
  const g = new BufferGeometry();
  const n = uvs.length / 2;
  g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aUV', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('aSide', new BufferAttribute(new Float32Array(side), 1));
  g.setAttribute('aKind', new BufferAttribute(new Float32Array(kind), 1));
  g.setIndex(index);
  return g;
}

export class Curtain {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private open = 1; // 0 closed .. 1 open
  private from = 1;
  private to = 1;
  private t = 1;
  private dur = 1;
  private sway = 0;
  private time = 0;
  private pending: Deferred | null = null;

  constructor(
    ctx: UICtx,
    private readonly cafe: Cafe | null,
  ) {
    this.mat = new ShaderMaterial({
      name: 'ui-curtain',
      uniforms: {
        uOpen: { value: 1 },
        uDrop: { value: 0 },
        uTime: { value: 0 },
        uSway: { value: 0 },
        uBase: { value: new Vector3(0, L.tableY - 0.004, Z) },
        uWidth: { value: WIDTH },
        uHeight: { value: HEIGHT },
        uValH: { value: VAL_H },
        uLampX: { value: 0 },
      },
      vertexShader: VS,
      fragmentShader: FS,
      toneMapped: true,
      alphaToCoverage: true,
    });
    this.mesh = new Mesh(buildGeometry(), this.mat);
    this.mesh.name = 'ui-curtain';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    ctx.root.add(this.mesh);
  }

  get isClosed(): boolean {
    return this.to === 0;
  }

  go(state: 'open' | 'closed'): Promise<void> {
    const target = state === 'open' ? 1 : 0;
    this.pending?.resolve(); // a superseded move resolves immediately
    this.pending = null;
    if (this.to === target && this.t >= 1 && this.open === target) return Promise.resolve();
    this.from = this.open;
    this.to = target;
    this.t = 0;
    this.dur = (target === 0 ? 1.15 : 1.3) * Math.max(0.35, Math.abs(this.to - this.from));
    this.pending = deferred();
    this.mesh.visible = true;
    return this.pending.promise;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.dur);
      const k = easeInOutCubic(this.t);
      this.open = this.from + (this.to - this.from) * k;
      this.sway = Math.min(0.012, this.sway + dt * 0.03);
      try {
        this.cafe?.setLamp(0.55 + 0.45 * this.open);
      } catch {
        /* café lamp is best-effort */
      }
      if (this.t >= 1) {
        this.open = this.to;
        this.pending?.resolve();
        this.pending = null;
      }
    } else {
      this.sway *= Math.exp(-dt * 1.6);
    }
    const visible = this.open < 0.999 || this.t < 1;
    this.mesh.visible = visible;
    if (!visible) return;
    const u = this.mat.uniforms;
    u.uOpen.value = this.open;
    // the valance drops a beat before the panels meet, and lifts as they part
    u.uDrop.value = clamp01((1 - this.open) * 2.2);
    u.uTime.value = this.time;
    u.uSway.value = this.sway;
  }

  dispose(): void {
    this.pending?.resolve();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
