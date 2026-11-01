// Shared design vocabulary for the felt puppets: the standard skeleton every kind uses, Muppet-style
// ping-pong eyes (gloss white sclera + gloss black pupil cap + felt eyelids), and the design record the
// Spectator runtime consumes. Puppet space: metres, feet at y = 0, +Z faces the player, +X = the puppet's LEFT.
import type { BufferGeometry } from '@iwsdk/core';
import type { SpectatorAnchor, SpectatorKind } from '../../contracts.js';
import { PuppetBuilder, add, alignY, alignZ, norm, onEllipsoid, prim, yawPitch, type BoneDef, type V3 } from '../builder.js';
import { DEG } from '../math.js';

export interface Traits {
  /** Head-spring speed multiplier (1 = CFG). */
  stiff: number;
  /** Bird-style stepped head motion: hold, snap, hold (magpie). */
  bird: boolean;
  /** Lives in a top hat on the table (rabbit). */
  hat: boolean;
  /** Secondary-motion gain for ears and tail. */
  earFlop: number;
  tailFlop: number;
  /** Rest lean back (Brock's pompous posture), radians. */
  pompous: number;
  /** Hop height scale. */
  hop: number;
  /** Arms are wings (flap instead of clap). */
  wings: boolean;
}

export interface PuppetDesign {
  kind: SpectatorKind;
  key: string;
  defs: BoneDef[];
  felt: BufferGeometry;
  gloss: BufferGeometry;
  headRadius: number;
  /** Top of the head (puppet units). */
  height: number;
  eyeL: V3;
  eyeR: V3;
  eyeRadius: number;
  /** Outward yaw of the left eye's facing (the right eye mirrors it); lids hinge about the matching axis. */
  eyeYaw: number;
  /** Upper-lid rotation (rad) that fully closes the eye; lower-lid rise for a full smile. */
  lidClose: number;
  lidRise: number;
  /** Eye-glyph height above the head pivot (puppet units). */
  glyphY: number;
  /** Front edge of the feet (topple pivot). */
  toeZ: number;
  /** Mover height at rest (the rabbit stands on the hat's inner floor). */
  restLift: number;
  anchors: Record<SpectatorAnchor, { bone: string; p: V3 }>;
  traits: Traits;
}

export const DEFAULT_TRAITS: Traits = {
  stiff: 1,
  bird: false,
  hat: false,
  earFlop: 1,
  tailFlop: 1,
  pompous: 0,
  hop: 1,
  wings: false,
};

/** Felt looks a touch dark under the matcap + ACES; a small gain keeps the palette honest. */
export const FELT_GAIN = 1.1;
export const LIGHT_LIFT = 0.42;
/** Eye whites live in the darker gloss matcap: push them up so they read as ping-pong-ball white. */
export const EYE_WHITE_GAIN = 2.45;
/** Gloss-slot gain for coloured shiny bits (brass, pink nose, teeth): the gloss matcap is dark and un-tonemapped. */
export const GLOSS_GAIN = 2.2;
export const PUPIL = 0x111117;
/** Fraction of the eye's outward facing the lids follow (full = lids centred on the eye's own front). */
const LID_YAW = 0.85;
export const MOUTH_DARK = 0x4a1820;
export const TONGUE = 0xe0707e;

export interface BonePositions {
  chest: V3;
  head: V3; // neck pivot
  earL: V3; // left ear base (+X); the right one is mirrored
  mouth: V3;
  jaw: V3;
  cheekL: V3;
  armL: V3; // left shoulder
  handL: V3;
  /** Right-hand overrides when the arms are not mirror images (Brock's pencil hand). */
  armR?: V3;
  handR?: V3;
  tail: V3;
  nose: V3;
}

const mx = (v: V3): V3 => [-v[0], v[1], v[2]];

/** Declare the standard skeleton (eye bones are added by `addEyes`). */
export function standardBones(b: PuppetBuilder, p: BonePositions): void {
  b.bone('root', null, [0, 0, 0]);
  b.bone('hat', null, [0, 0, 0]);
  b.bone('body', 'root', [0, 0.001, 0]);
  b.bone('chest', 'root', p.chest);
  b.bone('tail', 'root', p.tail);
  b.bone('head', 'chest', p.head);
  b.bone('earL', 'head', p.earL);
  b.bone('earR', 'head', mx(p.earL));
  b.bone('mouth', 'head', p.mouth);
  b.bone('jaw', 'head', p.jaw);
  b.bone('cheekL', 'head', p.cheekL);
  b.bone('cheekR', 'head', mx(p.cheekL));
  b.bone('nose', 'head', p.nose);
  b.bone('armL', 'chest', p.armL);
  b.bone('armR', 'chest', p.armR ?? mx(p.armL));
  b.bone('handL', 'armL', p.handL);
  b.bone('handR', 'armR', p.handR ?? mx(p.handL));
}

export interface EyeSpec {
  /** Head ellipsoid the eyes sit in. */
  head: V3;
  radii: V3;
  /** Facing direction of the LEFT eye (+X side); mirrored for the right one. */
  dir: V3;
  r: number;
  /** How far the sclera centre sits inside the head surface, as a fraction of r. */
  inset: number;
  /** Pupil radius as a fraction of r. */
  pupil: number;
  lid: number; // upper-lid felt colour
  low: number; // lower-lid felt colour
  /** Upper-lid edge elevation when open, lower-lid edge elevation (degrees above the eye's equator). */
  upperEdge: number;
  lowerEdge: number;
}

/**
 * Ping-pong eyes. Bones eyeL/eyeR (pupil), lidL/lidR (upper lid), lowL/lowR (lower lid) all sit at the sclera
 * centre with identity bind rotation, so rotating them about their own centre slides pupils and lids over
 * the sclera. Pupils are thin caps conforming to the sphere (no gaps at grazing angles).
 */
export function addEyes(b: PuppetBuilder, s: EyeSpec): { eyeL: V3; eyeR: V3; eyeYaw: number; lidClose: number; lidRise: number } {
  const eyeL = onEllipsoid(s.head, s.radii, s.dir, s.r * s.inset);
  const eyeR = mx(eyeL);
  const eyeYaw = Math.atan2(s.dir[0], s.dir[2]) * LID_YAW;
  for (const [side, c, sx] of [['L', eyeL, 1], ['R', eyeR, -1]] as const) {
    b.bone(`eye${side}`, 'head', c);
    b.bone(`lid${side}`, 'head', c);
    b.bone(`low${side}`, 'head', c);
    // sclera (gloss white) rides the head
    b.gloss('head', prim.sphere(22, 16), 0xffffff, { p: c, s: s.r, gain: EYE_WHITE_GAIN });
    // pupil: cap around +Z, a hair above the sclera
    const theta = Math.asin(Math.min(0.95, s.pupil));
    b.gloss(`eye${side}`, prim.cap(theta, 18, 4), PUPIL, { p: c, r: [Math.PI / 2, 0, 0], s: s.r * 1.035 });
    // Lids are hemispheres whose edge is a great circle through the eye's corners, pre-rotated to the open pose
    // and turned to the eye's facing: the runtime hinges them about that same yawed axis, like real eyelids.
    b.felt(`lid${side}`, prim.shell(0, Math.PI / 2, 20, 7), s.lid, { p: c, r: yawPitch(eyeYaw * sx, -s.upperEdge * DEG), s: s.r * 1.085 });
    b.felt(`low${side}`, prim.shell(Math.PI / 2, Math.PI / 2, 20, 5), s.low, {
      p: c,
      r: yawPitch(eyeYaw * sx, -s.lowerEdge * DEG),
      s: s.r * 1.065,
    });
  }
  return {
    eyeL,
    eyeR,
    eyeYaw,
    lidClose: (s.upperEdge - s.lowerEdge + 5) * DEG,
    lidRise: (-3 - s.lowerEdge) * DEG,
  };
}

/** Where a blush sits: on the cheek ellipsoid surface along `dir` (use it for the cheekL bone too). */
export function blushPoint(c: V3, r: V3, dir: V3): V3 {
  return onEllipsoid(c, r, dir, -0.0003);
}

/**
 * Rosy blush caps hugging the cheeks (bones cheekL/cheekR at `blushPoint`, scaled 0..1 at runtime): a spherical
 * cap whose sphere touches the cheek ellipsoid along `dir`, so it conforms instead of sticking out like a flap.
 */
export function addBlush(b: PuppetBuilder, c: V3, r: V3, dir: V3, angle: number, color: number): void {
  const d = norm(dir);
  const t = 1 / Math.sqrt((d[0] / r[0]) ** 2 + (d[1] / r[1]) ** 2 + (d[2] / r[2]) ** 2) + 0.0005;
  b.felt('cheekL', prim.cap(angle, 18, 4), color, { p: c, r: alignY(d), s: t });
  b.felt('cheekR', prim.cap(angle, 18, 4), color, { p: mx(c), r: alignY(mx(d)), s: t });
}

/** "O" mouth (hidden at scale 0): dark felt oval + tongue. */
export function addMouth(b: PuppetBuilder, at: V3, w: number, dir: V3 = [0, -0.15, 1]): void {
  const r = alignZ(norm(dir));
  b.felt('mouth', prim.sphere(16, 12), MOUTH_DARK, { p: at, r, s: [w, w * 0.88, w * 0.42] });
  b.felt('mouth', prim.sphere(12, 8), TONGUE, { p: add(at, [0, -w * 0.38, w * 0.2]), r, s: [w * 0.62, w * 0.34, w * 0.3] });
}

export { mx };
