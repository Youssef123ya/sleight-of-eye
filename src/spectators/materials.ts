// Shared GPU resources for every spectator (reference counted): one felt material, one glossy button-eye
// material, the eye-glyph atlas, and the sight-cone fan geometry. Per-instance materials (glyph tint, cone
// uniforms) reuse the same shader programs.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  FrontSide,
  MeshMatcapMaterial,
  NormalBlending,
  SRGBColorSpace,
  ShaderMaterial,
  SpriteMaterial,
} from '@iwsdk/core';
import { feltMaterial, matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { DEG } from './math.js';

export interface SharedResources {
  felt: MeshMatcapMaterial;
  gloss: MeshMatcapMaterial;
  atlas: CanvasTexture;
  coneGeo: BufferGeometry;
}

let shared: SharedResources | null = null;
let refs = 0;

export function acquireShared(): SharedResources {
  if (!shared) {
    shared = { felt: feltMaterial({ fuzz: 0.08 }), gloss: glossMaterial(), atlas: makeGlyphAtlas(), coneGeo: makeConeGeometry(34 * DEG, 32) };
  }
  refs++;
  return shared;
}

export function releaseShared(): void {
  if (!shared || --refs > 0) return;
  shared.felt.dispose();
  shared.gloss.dispose();
  shared.atlas.dispose();
  shared.coneGeo.dispose();
  shared = null;
}

/**
 * Glossy button eyes: the 'glossy' matcap preset plus a crisp specular dot that is ADDED (not multiplied by the
 * vertex colour), so black pupils, the black nose and brass still glint. View-space normals → multiview-safe.
 */
function glossMaterial(): MeshMatcapMaterial {
  const m = matcapMaterial('glossy');
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;',
      `vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
      float soeKey = dot( normal, normalize( vec3( -0.36, 0.5, 0.79 ) ) );
      float soeFill = dot( normal, normalize( vec3( 0.42, -0.3, 0.86 ) ) );
      outgoingLight += vec3( smoothstep( 0.955, 0.982, soeKey ) * 0.95 + smoothstep( 0.988, 0.997, soeFill ) * 0.3 );`,
    );
  };
  m.customProgramCacheKey = () => 'soe-gloss-1';
  m.toneMapped = false; // eye whites must read white and highlights crisp; vertex gains are tuned for this
  return m;
}

// ------------------------------------------------------------------------------------------- eye glyphs
export const GLYPH_CELLS = 4; // 0 open, 1 half, 2 closed, 3 alert
const CELL = 128;

function makeGlyphAtlas(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * GLYPH_CELLS;
  canvas.height = CELL;
  const g = canvas.getContext('2d')!;
  for (let i = 0; i < GLYPH_CELLS; i++) drawGlyph(g, i * CELL + CELL / 2, CELL / 2, i);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** White line art on a dark felt-like badge; the per-instance SpriteMaterial colour tints the white parts. */
function drawGlyph(g: CanvasRenderingContext2D, cx: number, cy: number, state: number): void {
  const ink = 'rgba(26,18,34,0.86)';
  g.save();
  g.translate(cx, cy);
  // soft halo for contrast against the cloth, then the badge and its ring
  const halo = g.createRadialGradient(0, 0, 40, 0, 0, 63);
  halo.addColorStop(0, 'rgba(10,6,16,0.5)');
  halo.addColorStop(1, 'rgba(10,6,16,0)');
  g.fillStyle = halo;
  g.fillRect(-64, -64, 128, 128);
  g.fillStyle = ink;
  g.beginPath();
  g.arc(0, 0, 52, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(0, 0, 49, 0, Math.PI * 2);
  g.stroke();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = 7.5;
  if (state === 0 || state === 3) {
    const h = state === 3 ? 30 : 24;
    almond(g, 34, h);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(0, 1, state === 3 ? 10 : 13, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = ink;
    g.beginPath();
    g.arc(4, -3, state === 3 ? 3.5 : 4.5, 0, Math.PI * 2);
    g.fill();
    if (state === 3) {
      for (const a of [-0.6, 0, 0.6]) {
        g.beginPath();
        g.moveTo(Math.sin(a) * 34, -Math.cos(a) * 34 - 2);
        g.lineTo(Math.sin(a) * 41, -Math.cos(a) * 41 - 2);
        g.stroke();
      }
    }
  } else if (state === 1) {
    almond(g, 34, 24);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.rect(-34, 0, 68, 26);
    g.clip();
    g.beginPath();
    g.arc(0, 1, 13, 0, Math.PI * 2);
    g.fill();
  } else {
    // closed: a sleepy downward arc with three lashes
    g.beginPath();
    g.moveTo(-34, -4);
    g.quadraticCurveTo(0, 26, 34, -4);
    g.stroke();
    g.lineWidth = 6;
    for (const t of [0.25, 0.5, 0.75]) {
      const x = -34 + 68 * t;
      const y = -4 + 2 * (1 - t) * t * 30;
      g.beginPath();
      g.moveTo(x, y + 3);
      g.lineTo(x + (t - 0.5) * 14, y + 13);
      g.stroke();
    }
  }
  g.restore();
}

function almond(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.beginPath();
  g.moveTo(-w, 0);
  g.quadraticCurveTo(0, -h * 1.45, w, 0);
  g.quadraticCurveTo(0, h * 1.45, -w, 0);
  g.closePath();
}

export function glyphMaterial(atlas: CanvasTexture, color: number): SpriteMaterial {
  return new SpriteMaterial({
    map: atlas,
    color,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    sizeAttenuation: true,
  });
}

/** Per-glyph quad (same layout as three's sprite quad) so each glyph picks its own atlas cell via UVs. */
export function glyphGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(8), 2));
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  setGlyphCell(g, 0);
  return g;
}

export function setGlyphCell(g: BufferGeometry, cell: number): void {
  const uv = g.attributes.uv as BufferAttribute;
  const u0 = cell / GLYPH_CELLS + 0.002;
  const u1 = (cell + 1) / GLYPH_CELLS - 0.002;
  uv.setXY(0, u0, 0);
  uv.setXY(1, u1, 0);
  uv.setXY(2, u1, 1);
  uv.setXY(3, u0, 1);
  uv.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------- sight cone
/** Flat fan in the XZ plane: apex at the origin, pointing +Z, unit radius, spanning ±maxHalf. */
function makeConeGeometry(maxHalf: number, segs: number): BufferGeometry {
  const pos = new Float32Array((segs + 2) * 3);
  for (let i = 0; i <= segs; i++) {
    const a = -maxHalf + (2 * maxHalf * i) / segs;
    pos[(i + 1) * 3] = Math.sin(a);
    pos[(i + 1) * 3 + 2] = Math.cos(a);
  }
  const idx = new Uint16Array(segs * 3);
  for (let i = 0; i < segs; i++) {
    idx[i * 3] = 0;
    idx[i * 3 + 1] = i + 1;
    idx[i * 3 + 2] = i + 2;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Soft wedge with a brighter rim, slow outward ripples and a red alarm pulse. One per spectator (uniforms). */
export function coneMaterial(color: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uAlarmColor: { value: new Color(PAL.alarm) },
      uOpacity: { value: 0 },
      uAlarm: { value: 0 },
      uTime: { value: 0 },
      uHalf: { value: 22 * DEG },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uAlarmColor;
      uniform float uOpacity;
      uniform float uAlarm;
      uniform float uTime;
      uniform float uHalf;
      varying vec2 vP;
      void main() {
        float r = length( vP );
        float a = abs( atan( vP.x, vP.y ) ) / uHalf;
        float inside = 1.0 - smoothstep( 0.86, 1.04, a );
        float rim = smoothstep( 0.62, 0.95, a ) * ( 1.0 - smoothstep( 0.95, 1.06, a ) );
        float radial = smoothstep( 0.0, 0.12, r ) * ( 1.0 - smoothstep( 0.55, 1.0, r ) );
        float ripple = 0.8 + 0.2 * sin( r * 30.0 - uTime * ( 3.0 + 5.0 * uAlarm ) );
        float pulse = 0.5 + 0.5 * sin( uTime * 10.0 );
        vec3 col = mix( uColor, uAlarmColor, uAlarm );
        float alpha = uOpacity * radial * ( inside * ripple * 0.8 + rim * 0.65 ) * ( 1.0 + uAlarm * ( 0.6 + 1.1 * pulse ) );
        gl_FragColor = vec4( col, clamp( alpha, 0.0, 1.0 ) );
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    side: FrontSide,
    toneMapped: false,
  });
}
