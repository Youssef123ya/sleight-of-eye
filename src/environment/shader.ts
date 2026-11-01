// ONE shader program for every custom effect the café draws: the glow + contact-shadow decal batches, every particle
// FX kind (billboards and tumbling confetti / rose petals), the night window, the lamp beam and the emissive bulbs.
// Each use is its own ShaderMaterial (own uniforms, blending, depth state, render order) and picks its path with the
// `uKind` uniform. three.js keys programs on the shader source + material/geometry parameters, so as long as every
// material here keeps the SAME parameters, they all share one compiled program (one compile hitch, not seven):
//   - FrontSide, transparent: true, toneMapped: false, no defines, vertexColors off (the `color` attribute is declared
//     below by hand), and EVERY geometry has `position` + `normal` (`vertexNormals` is part of the key).
//   - Opaque users (night pane, emissive bulbs, confetti) output alpha 1 with depthWrite on, so the transparent pass
//     draws exactly the same pixels; double-sided particles get explicit back faces (see doubleSided()).
// Blending, depth write/test and polygon offset are GL state, not program state, so they may differ freely.
import { BufferGeometry, Float32BufferAttribute, FrontSide, NormalBlending, ShaderMaterial, type Blending } from '@iwsdk/core';

export const KIND = { batch: 0, particle: 1, tumble: 2, night: 3, beam: 4, emissive: 5 } as const;

const VS = /* glsl */ `
attribute vec3 color;  // emissive: baked vertex colour
attribute vec3 iPos;   // batch: centre          · particle: origin
attribute vec2 iSize;  // batch: size (m)
attribute vec4 iColor; // batch: rgba            · particle: rgb + birth time
attribute vec4 iParam; // batch: cell, mode, rot, arc · particle: cell, size scale, life scale, -
attribute vec3 iVel;   // particle: initial velocity
attribute vec4 iSeed;  // particle: random seeds
uniform float uKind;
uniform vec3 uCam;     // batch: camera position in the batch's space (upright billboards)
uniform vec4 uClock;   // x = seconds (particles, night sky)
uniform float uLife;
uniform vec3 uGravity;
uniform float uDrag;
uniform vec4 uSize;    // particles: start, end, pop-in speed, streak factor
uniform vec4 uFade;    // particles: fade-in frac, fade-out start frac, spin, flutter
uniform float uBeamH;  // beam: cone height
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vMisc;    // x = atlas cell, y = arc, z = shade (tumble) / facing (beam), w = height fraction (beam)

vec3 fxPos(float age, out vec3 vel) {
  float k = max(uDrag, 0.001);
  float e = exp(-k * age);
  vec3 vt = uGravity / k;
  vel = vt + (iVel - vt) * e;
  vec3 p = iPos + vt * age + (iVel - vt) * (1.0 - e) / k;
  float fl = uFade.w * min(age * 1.5, 1.0);
  p.x += sin(age * (3.0 + iSeed.x * 3.0) + iSeed.y * 6.2831) * fl;
  p.z += cos(age * (2.6 + iSeed.z * 3.0) + iSeed.w * 6.2831) * fl;
  return p;
}

vec3 rotAxis(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

void main() {
  vUv = uv;
  vColor = vec4(1.0);
  vMisc = vec4(0.0, 1.0, 1.0, 0.0);
  vec4 mv;
  if (uKind < 0.5) {
    // ---- decal batch quad. modes: 0 billboard, 1 flat (XZ), 2 upright (yaw to camera), 3 pushed billboard,
    //      4 flat contact shadow (scale THEN rotate, so stretched blobs turn rigidly)
    float mode = iParam.y;
    float cr = cos(iParam.z);
    float sr = sin(iParam.z);
    vec2 c = position.xy;
    vec2 q;
    if (mode > 3.5) {
      vec2 s = c * iSize;
      q = vec2(s.x * cr - s.y * sr, s.x * sr + s.y * cr);
    } else {
      q = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * iSize;
    }
    if (mode < 0.5 || (mode > 2.5 && mode < 3.5)) {
      mv = modelViewMatrix * vec4(iPos, 1.0);
      if (mode > 2.5) mv.xyz += normalize(-mv.xyz) * 0.75 * max(iSize.x, iSize.y);
      mv.xy += q;
    } else if (mode < 1.5 || mode > 3.5) {
      mv = modelViewMatrix * vec4(iPos + vec3(q.x, 0.0, -q.y), 1.0);
    } else {
      vec3 tc = uCam - iPos;
      vec2 h = vec2(tc.z, -tc.x);
      float hl = length(h);
      vec3 right = hl > 1e-5 ? vec3(h.x / hl, 0.0, h.y / hl) : vec3(1.0, 0.0, 0.0);
      mv = modelViewMatrix * vec4(iPos + right * q.x + vec3(0.0, q.y, 0.0), 1.0);
    }
    vColor = iColor;
    vMisc.x = iParam.x;
    vMisc.y = iParam.w;
  } else if (uKind < 2.5) {
    // ---- particles: the CPU only writes a slot at emit time; motion, size and fade happen here
    float life = uLife * iParam.z;
    float age = uClock.x - iColor.w;
    float t = age / life;
    float alive = step(0.0, age) * step(t, 1.0);
    vec3 vel;
    vec3 p = fxPos(max(age, 0.0), vel);
    if (uKind < 1.5) {
      float s = mix(uSize.x, uSize.y, clamp(t, 0.0, 1.0)) * iParam.y;
      if (uSize.z > 0.0) s *= clamp(t * uSize.z, 0.0, 1.0);
      s *= alive;
      float a = alive * clamp(t / max(uFade.x, 0.001), 0.0, 1.0) * (1.0 - smoothstep(uFade.y, 1.0, t));
      mv = modelViewMatrix * vec4(p, 1.0);
      vec2 c = position.xy;
      if (uSize.w > 0.0) {
        vec2 vv = (modelViewMatrix * vec4(vel, 0.0)).xy;
        float sp = length(vv);
        vec2 dir = sp > 0.0001 ? vv / sp : vec2(1.0, 0.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        mv.xy += dir * c.x * (s + sp * uSize.w * alive) + nrm * c.y * s;
      } else {
        float ang = iSeed.x * 6.2831 + age * uFade.z * (iSeed.y - 0.5) * 2.0;
        float ca = cos(ang);
        float sa = sin(ang);
        mv.xy += vec2(c.x * ca - c.y * sa, c.x * sa + c.y * ca) * s;
      }
      vColor = vec4(iColor.rgb, a);
      vMisc.x = iParam.x;
    } else {
      float s = uSize.x * iParam.y * alive * smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.82, 1.0, t));
      vec3 axis = normalize(iSeed.xyz - 0.5 + vec3(0.0013, 0.0021, 0.0007));
      float ang = iSeed.w * 6.2831 + age * uFade.z * (0.5 + iSeed.x);
      vec3 lp = rotAxis(position * s, axis, ang);
      vec3 n = rotAxis(normal, axis, ang);
      mv = modelViewMatrix * vec4(p + lp, 1.0);
      float facing = abs(normalize(normalMatrix * n).z);
      vColor = vec4(iColor.rgb, 1.0);
      vMisc.z = 0.45 + 0.55 * facing + 0.5 * pow(facing, 18.0);
    }
  } else {
    // ---- plain meshes: night pane, lamp beam, emissive bulbs
    mv = modelViewMatrix * vec4(position, 1.0);
    if (uKind > 3.5 && uKind < 4.5) {
      vec3 n = normalize(normalMatrix * normal);
      vMisc.z = abs(dot(n, normalize(-mv.xyz)));
      vMisc.w = position.y / uBeamH + 0.5;
    } else if (uKind > 4.5) {
      vColor = vec4(color, 1.0);
    }
  }
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */ `
uniform float uKind;
uniform sampler2D uAtlas;
uniform float uShade;    // particles: shade from the atlas G/R ratio (puffs, stars)
uniform vec4 uClock;
uniform float uAspect;   // night pane aspect
uniform vec4 uTint;      // beam: rgb colour, a = lamp level · emissive: rgb tint (lamp level)
uniform float uExposure; // tumble: renderer tone-mapping exposure (confetti is lit like the set: ACES)
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vMisc;

vec2 atlasUv(float cell, vec2 uv) {
  float col = mod(cell, 8.0);
  float row = floor(cell / 8.0 + 0.001);
  return vec2((col + uv.x) / 8.0, (1.0 - row + uv.y) / 2.0);
}

// three.js ACESFilmicToneMapping (r185), applied by hand because this shared material is not tone-mapped
vec3 acesFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = acesFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// deep-blue night: gradient sky, twinkling stars, a crescent moon, rooftops with warm windows, glass sheen
vec3 nightSky(vec2 uv) {
  float uTime = uClock.x;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  vec3 col = mix(vec3(0.05, 0.075, 0.32), vec3(0.008, 0.012, 0.075), smoothstep(0.12, 0.95, uv.y));
  vec2 mc = vec2(0.66 * uAspect, 0.8);
  float dm = length(p - mc);
  col += vec3(0.35, 0.42, 0.75) * exp(-dm * dm * 26.0) * 0.32;
  float disk = 1.0 - smoothstep(0.066, 0.072, dm);
  float bite = 1.0 - smoothstep(0.06, 0.066, length(p - mc - vec2(0.03, 0.022)));
  col = mix(col, vec3(1.0, 0.96, 0.82), disk * (1.0 - bite));
  vec2 g = p * 34.0;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float hs = hash(id);
  if (hs > 0.8) {
    vec2 o = vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5;
    float d = length(f - o * 0.6);
    float tw = 0.45 + 0.55 * sin(uTime * (1.2 + hs * 3.5) + hs * 40.0);
    float star = (1.0 - smoothstep(0.0, 0.14, d)) * (hs - 0.8) * 5.0 * tw;
    col += vec3(0.85, 0.9, 1.0) * star * smoothstep(0.25, 0.45, uv.y);
  }
  float bx = floor(p.x * 7.0);
  float bh = 0.1 + 0.2 * hash(vec2(bx, 2.0));
  float roof = bh + 0.05 * (1.0 - abs(fract(p.x * 7.0) - 0.5) * 2.0) * step(0.5, hash(vec2(bx, 5.0)));
  float chim = step(0.72, hash(vec2(bx, 9.0))) * step(abs(fract(p.x * 7.0) - 0.3), 0.06) * step(uv.y, roof + 0.05);
  float building = max(step(uv.y, roof), chim);
  vec3 bcol = vec3(0.012, 0.014, 0.04);
  vec2 wg = vec2(p.x * 7.0 * 4.0, uv.y * 30.0);
  vec2 wid = floor(wg);
  vec2 wf = fract(wg);
  float lit = step(0.7, hash(wid + bx));
  float pulse = 0.75 + 0.25 * sin(uTime * 0.3 + hash(wid) * 30.0);
  float win = lit * step(0.25, wf.x) * step(wf.x, 0.75) * step(0.3, wf.y) * step(wf.y, 0.8) * step(uv.y, bh - 0.025);
  bcol += vec3(1.0, 0.62, 0.25) * win * 0.55 * pulse;
  col = mix(col, bcol, building);
  col += vec3(0.5, 0.3, 0.12) * exp(-((uv.x - 0.15) * (uv.x - 0.15) * 30.0 + (uv.y - 0.25) * (uv.y - 0.25) * 18.0)) * 0.08;
  col *= 0.75 + 0.25 * smoothstep(0.0, 0.12, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  return col;
}

void main() {
  vec4 col;
  if (uKind < 1.5) {
    // decals + billboard particles: coverage in R, optional shade in G/R, optional dwell-ring arc mask
    vec4 tx = texture2D(uAtlas, atlasUv(vMisc.x, vUv));
    float a = tx.r;
    float arc = vMisc.y;
    if (arc < 0.999) {
      vec2 d = vUv - 0.5;
      float t = fract(atan(d.x, d.y) / 6.2831853 + 1.0);
      float on = 1.0 - smoothstep(arc - 0.006, arc + 0.006, t);
      float head = smoothstep(arc - 0.08, arc, t) * on;
      a *= mix(0.14, 1.0, on) * (1.0 + 1.5 * head);
    }
    float sh = mix(1.0, tx.g / max(tx.r, 0.004), uShade);
    col = vec4(vColor.rgb * sh, a * vColor.a);
  } else if (uKind < 2.5) {
    col = vec4(aces(vColor.rgb * vMisc.z), 1.0);
  } else if (uKind < 3.5) {
    col = vec4(nightSky(vUv), 1.0);
  } else if (uKind < 4.5) {
    float h = vMisc.w;
    float a = pow(vMisc.z, 1.6) * smoothstep(0.0, 0.4, h) * (0.3 + 0.7 * h) * (1.0 - smoothstep(0.86, 1.0, h));
    col = vec4(uTint.rgb, a * 0.32 * uTint.a);
  } else {
    col = vec4(vColor.rgb * uTint.rgb, 1.0);
  }
  gl_FragColor = col;
  #include <colorspace_fragment>
}`;

export interface EnvShaderOpts {
  name: string;
  kind: number;
  uniforms?: Record<string, { value: unknown }>;
  blending?: Blending;
  depthWrite?: boolean;
  polygonOffset?: boolean;
}

/** A material on the café's shared program (see the header for the rules that keep it shared). */
export function envShaderMaterial(o: EnvShaderOpts): ShaderMaterial {
  const m = new ShaderMaterial({
    name: o.name,
    uniforms: { uKind: { value: o.kind }, ...(o.uniforms ?? {}) },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: o.depthWrite ?? false,
    blending: o.blending ?? NormalBlending,
    side: FrontSide,
    toneMapped: false,
  });
  if (o.polygonOffset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  return m;
}

export { AdditiveBlending, NormalBlending } from '@iwsdk/core';

/**
 * Same surface seen from both sides with FrontSide culling (keeps the shared program key): appends a reversed copy
 * of every triangle with flipped normals. Returns a new non-shared geometry (position + normal [+ uv]).
 */
export function doubleSided(src: BufferGeometry): BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position.array as ArrayLike<number>;
  const nor = g.attributes.normal.array as ArrayLike<number>;
  const uv = g.attributes.uv?.array as ArrayLike<number> | undefined;
  const n = g.attributes.position.count;
  const P = new Float32Array(n * 6);
  const N = new Float32Array(n * 6);
  const U = uv ? new Float32Array(n * 4) : null;
  for (let i = 0; i < n * 3; i++) {
    P[i] = pos[i];
    N[i] = nor[i];
  }
  if (U && uv) for (let i = 0; i < n * 2; i++) U[i] = uv[i];
  // back faces: same triangles, reversed winding (swap the 2nd and 3rd vertex), normals flipped
  for (let t = 0; t < n / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const s = t * 3 + (k === 0 ? 0 : 3 - k);
      const d = n + t * 3 + k;
      for (let c = 0; c < 3; c++) {
        P[d * 3 + c] = pos[s * 3 + c];
        N[d * 3 + c] = -nor[s * 3 + c];
      }
      if (U && uv) {
        U[d * 2] = uv[s * 2];
        U[d * 2 + 1] = uv[s * 2 + 1];
      }
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new Float32BufferAttribute(N, 3));
  if (U) out.setAttribute('uv', new Float32BufferAttribute(U, 2));
  g.dispose();
  return out;
}
