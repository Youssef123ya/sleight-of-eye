// Procedural reaction library: each reaction writes additive channels into a Pose as a pure function of its
// local time. Squash/stretch, anticipation and overshoot live here; positions of hops live in the spectator.
import { CFG } from '../config.js';
import type { ReactionName, SpectatorKind } from '../contracts.js';
import type { Traits } from './designs/common.js';
import { DEG, TAU, bump, copy3, easeInCubic, easeInOut, easeOutBack, env, lerp, seg, set3 } from './math.js';
import { PK, type Pose } from './pose.js';

/** Default durations (seconds); `opts.duration` overrides the looping ones. */
export const REACTION_DURATION: Record<ReactionName, number> = {
  leanIn: 1.6,
  gasp: 1.45,
  topple: 3.9,
  pointSqueak: 1.6,
  clap: 2.4,
  cheer: 2.3,
  giggle: 1.7,
  blushScribble: CFG.flusterDuration,
  hopToVolunteer: 1.55,
  hopBack: 1.55,
  bow: 1.9,
  idle: 0,
};

/** Reactions that honour `opts.duration`. */
export const LOOPING = new Set<ReactionName>(['clap', 'cheer', 'giggle', 'blushScribble', 'leanIn']);
/** Crowd reactions get a little per-puppet stagger so the row never moves in lockstep. */
export const STAGGERED = new Set<ReactionName>(['leanIn', 'gasp', 'clap', 'cheer', 'giggle', 'bow']);

/** Hop timeline (fractions of the hop duration): turn, crouch, take-off, land, face the player. */
export const HOP = { turnEnd: 0.16, takeoff: 0.24, land: 0.66, faceStart: 0.72, faceEnd: 0.9 } as const;

export interface ReactionCtx {
  kind: SpectatorKind;
  traits: Traits;
  t: number;
  dur: number;
  I: number;
  seed: number;
  /** Riser height below the feet (puppet units); 0 when not standing on the riser. */
  drop: number;
  toeZ: number;
  inHat: boolean;
  /** Unit direction (chest space, x y z) to the reaction target, and whether one was given. */
  target: Float64Array;
  hasTarget: boolean;
  /** Out: arm aim directions (chest space, x y z, need not be normalised). */
  aimL: Float64Array;
  aimR: Float64Array;
}

export function poseReaction(name: ReactionName, c: ReactionCtx, o: Pose): void {
  switch (name) {
    case 'leanIn':
      return leanIn(c, o);
    case 'gasp':
      return gasp(c, o);
    case 'topple':
      return c.inHat ? toppleHat(c, o) : topple(c, o);
    case 'pointSqueak':
      return pointSqueak(c, o);
    case 'clap':
      return clap(c, o);
    case 'cheer':
      return cheer(c, o);
    case 'giggle':
      return giggle(c, o);
    case 'blushScribble':
      return blushScribble(c, o);
    case 'hopToVolunteer':
    case 'hopBack':
      return hop(c, o);
    case 'bow':
      return bow(c, o);
    case 'idle':
      return;
  }
}

function arms(o: Pose, swing: number, raise: number): void {
  o[PK.armLSwing] += swing;
  o[PK.armRSwing] += swing;
  o[PK.armLRaise] += raise;
  o[PK.armRRaise] += raise;
}

function leanIn(c: ReactionCtx, o: Pose): void {
  const e = env(c.t, 0, c.dur, 0.38, 0.5) * c.I;
  o[PK.lean] += 13 * DEG * e;
  o[PK.y] += 0.0025 * e;
  o[PK.squash] += 0.05 * e;
  o[PK.wide] += 0.55 * e;
  o[PK.pupil] += 0.2 * e;
  o[PK.earPerk] += 0.75 * e;
  o[PK.mouth] += 0.3 * e;
  o[PK.tailWag] += Math.sin(c.t * 10) * 0.25 * e;
  if (c.traits.wings) {
    o[PK.armLRaise] += 18 * DEG * e;
    o[PK.armRRaise] += 18 * DEG * e;
    o[PK.beak] += 0.25 * e;
  } else if (c.kind === 'badger') {
    o[PK.notebook] += 0.25 * e;
    o[PK.nod] -= 4 * DEG * e;
  } else {
    arms(o, 32 * DEG * e, -14 * DEG * e);
  }
}

function gasp(c: ReactionCtx, o: Pose): void {
  const t = c.t;
  const sh = env(t, 0, c.dur, 0.06, 0.55) * c.I;
  const jolt = bump(t, 0, 0.22);
  o[PK.lean] -= 15 * DEG * sh;
  o[PK.y] += 0.006 * jolt * c.I;
  o[PK.squash] += (0.13 * jolt - 0.05 * bump(t, 0.2, 0.42)) * c.I;
  o[PK.mouth] += 1.05 * sh;
  o[PK.beak] += 1 * sh;
  o[PK.wide] += 1 * sh;
  o[PK.pupil] -= 0.2 * sh;
  o[PK.earPerk] += 1 * sh;
  o[PK.tailLift] += 0.8 * sh;
  o[PK.nod] -= 7 * DEG * sh;
  if (c.traits.wings) {
    o[PK.armLRaise] += 75 * DEG * sh;
    o[PK.armRRaise] += 75 * DEG * sh;
  } else if (c.kind === 'badger') {
    // pencil hand flies to his cheek, notebook clutched to the chest
    o[PK.aimR] += sh;
    set3(c.aimR, -0.55, 0.65, 0.55);
    o[PK.armLSwing] -= 12 * DEG * sh;
  } else {
    // paws fly up to the cheeks
    o[PK.aimL] += sh;
    o[PK.aimR] += sh;
    set3(c.aimL, 0.55, 0.5, 0.68);
    set3(c.aimR, -0.55, 0.5, 0.68);
    o[PK.reach] += 0.5 * sh;
  }
}

/** Leans in to look for the vanished coin… too far: faceplant off the riser, kick, pop up, dust off, hop back. */
function topple(c: ReactionCtx, o: Pose): void {
  const t = c.t;
  const D = c.drop;
  const E = c.drop > 0 ? 0.052 : 0.012; // forward travel over the riser edge
  const A0 = 0.95; // start falling
  const A1 = 1.25; // impact
  const B1 = 2.1; // push up
  const B2 = 2.45; // standing on the cloth
  const C1 = 2.85; // crouch for the hop back
  const C2 = 2.95; // take-off
  const C3 = 3.38; // landing on the riser
  o[PK.pivotZ] += c.toeZ;
  let lean = 0;
  let y = 0;
  let z = 0;
  let sq = 0;
  if (t < A0) {
    const k = easeInOut(seg(t, 0, 0.4));
    const teeter = seg(t, 0.35, A0);
    const osc = t > 0.35 ? Math.sin((t - 0.35) * TAU * 2.5) * (4 + 13 * teeter) : 0;
    lean = (15 * k + osc) * DEG;
    y = 0.002 * k;
    o[PK.wide] += 0.4 * k + 0.6 * teeter;
    o[PK.mouth] += 0.5 * teeter;
    o[PK.beak] += 0.5 * teeter;
    if (t > 0.4) {
      const a = t * TAU * 3.3;
      const w = seg(t, 0.4, 0.55);
      o[PK.armLSwing] += Math.sin(a) * 85 * DEG * w;
      o[PK.armRSwing] += Math.sin(a + Math.PI) * 85 * DEG * w;
      o[PK.armLRaise] += (40 + 30 * Math.cos(a)) * DEG * w;
      o[PK.armRRaise] += (40 - 30 * Math.cos(a)) * DEG * w;
      o[PK.tailWag] += Math.sin(a * 0.5) * 0.6 * w;
    }
  } else if (t < A1) {
    const f = easeInCubic(seg(t, A0, A1));
    lean = lerp(20 * DEG, 93 * DEG, f);
    z = E * f;
    y = -D * f;
    o[PK.wide] += 1;
    o[PK.mouth] += 0.9;
    o[PK.beak] += 0.9;
    arms(o, 150 * DEG * f, 25 * DEG);
    o[PK.tailLift] += 1;
  } else if (t < B1) {
    lean = 93 * DEG;
    z = E;
    y = -D + 0.0035 * bump(t, A1, A1 + 0.2);
    sq = -0.17 * bump(t, A1, A1 + 0.17);
    const k = env(t, A1 + 0.12, B1, 0.1, 0.12);
    o[PK.tailWag] += Math.sin(t * 24) * 0.9 * k;
    o[PK.tailLift] += 0.6 * k;
    arms(o, (155 + Math.sin(t * 17) * 22) * DEG, 30 * DEG);
    o[PK.armLRaise] += Math.sin(t * 19) * 15 * DEG * k;
    o[PK.armRRaise] -= Math.sin(t * 19) * 15 * DEG * k;
    o[PK.dizzy] += k;
    o[PK.override] += 1;
    o[PK.turn] += Math.sin(t * 8) * 14 * DEG * k;
    o[PK.lidClose] += 0.25 * k;
    o[PK.earL] += Math.sin(t * 13) * 0.4 * k;
    o[PK.earR] -= Math.sin(t * 13) * 0.4 * k;
  } else if (t < B2) {
    const u = easeOutBack(seg(t, B1, B2), 2.2);
    lean = lerp(93 * DEG, 0, u);
    z = lerp(E, E + 0.018, seg(t, B1, B2));
    y = -D + 0.008 * bump(t, B1, B2);
    sq = 0.1 * bump(t, B1 + 0.05, B2);
    o[PK.override] += 1 - seg(t, B1, B2) * 0.5;
    o[PK.wide] += 0.5;
    arms(o, 60 * DEG * (1 - u), 50 * DEG * bump(t, B1, B2));
  } else if (t < C1) {
    // dust off and shake the head
    z = E + 0.018;
    y = -D;
    const k = env(t, B2, C1, 0.06, 0.1);
    const pat = c.kind === 'badger' ? 0.25 : 1;
    o[PK.armLSwing] += (30 + 22 * Math.sin(t * 34)) * DEG * k * pat;
    o[PK.armRSwing] += (30 + 22 * Math.sin(t * 34 + 1.6)) * DEG * k * pat;
    o[PK.armLRaise] -= 22 * DEG * k * pat;
    o[PK.armRRaise] -= 22 * DEG * k * pat;
    o[PK.override] += 0.6 * k;
    o[PK.turn] += Math.sin(t * 22) * 16 * DEG * k;
    o[PK.nod] += 10 * DEG * k;
    o[PK.earL] += Math.sin(t * 26) * 0.5 * k;
    o[PK.earR] += Math.sin(t * 26 + 1) * 0.5 * k;
    o[PK.lidClose] += 0.5 * k;
    o[PK.tailWag] += Math.sin(t * 30) * 0.6 * k;
  } else {
    // hop backwards up onto the riser
    sq = -0.15 * bump(t, C1 - 0.03, C2 + 0.04);
    if (t < C2) {
      z = E + 0.018;
      y = -D;
    } else if (t < C3) {
      const p = seg(t, C2, C3);
      z = lerp(E + 0.018, 0, p);
      y = lerp(-D, 0, p) + (0.028 + D * 0.4) * 4 * p * (1 - p) * c.traits.hop;
      sq += 0.1 * (1 - p);
      lean = -10 * DEG * Math.sin(Math.PI * p);
      arms(o, 0, 60 * DEG * Math.sin(Math.PI * p));
      if (c.traits.wings) {
        o[PK.armLRaise] += Math.sin(t * 40) * 50 * DEG;
        o[PK.armRRaise] += Math.sin(t * 40) * 50 * DEG;
      }
    }
    sq -= 0.17 * bump(t, C3 - 0.02, C3 + 0.15);
  }
  // sheepish ending
  const sheep = env(t, C3 - 0.05, c.dur, 0.15, 0.3);
  o[PK.blush] += 0.85 * sheep;
  o[PK.lidLow] += 0.65 * sheep;
  o[PK.tilt] += 13 * DEG * sheep;
  o[PK.ears] += 0.45 * sheep;
  o[PK.lean] += lean;
  o[PK.y] += y;
  o[PK.z] += z;
  o[PK.squash] += sq;
}

/** The rabbit in its hat: shock sends it ducking inside, then it pops back up dizzy. */
function toppleHat(c: ReactionCtx, o: Pose): void {
  const t = c.t;
  const down = env(t, 0.25, 2.3, 0.18, 0.28);
  o[PK.wide] += bump(t, 0, 0.5) * 1;
  o[PK.y] += -0.075 * down + 0.012 * bump(t, 2.15, 2.55);
  o[PK.squash] += 0.12 * bump(t, 2.1, 2.5) - 0.1 * bump(t, 0.1, 0.3);
  const dz = env(t, 2.3, c.dur, 0.1, 0.4);
  o[PK.dizzy] += dz;
  o[PK.override] += dz * 0.6;
  o[PK.turn] += Math.sin(t * 9) * 12 * DEG * dz;
  o[PK.tilt] += Math.sin(t * 7) * 10 * DEG * dz;
  o[PK.ears] += 0.6 * dz;
}

function pointSqueak(c: ReactionCtx, o: Pose): void {
  const e = env(c.t, 0, c.dur, 0.1, 0.35) * c.I;
  const j = bump(c.t, 0.1, 0.28) + bump(c.t, 0.42, 0.6) + 0.75 * bump(c.t, 0.74, 0.92);
  o[PK.lookTarget] += 1;
  o[PK.lean] += (7 + 8 * j) * DEG * e;
  o[PK.y] += 0.0035 * j * c.I;
  o[PK.squash] += 0.07 * j * c.I;
  o[PK.mouth] += (0.55 + 0.45 * j) * e;
  o[PK.beak] += (0.6 + 0.4 * j) * e;
  o[PK.lidTilt] += 22 * DEG * e;
  o[PK.lidClose] += 0.12 * e;
  o[PK.wide] += 0.3 * j;
  o[PK.earPerk] += 0.6 * e;
  o[PK.tailLift] += 0.9 * e;
  const useLeft = c.kind === 'badger' ? false : c.hasTarget ? c.target[0] >= 0 : true;
  const dir = useLeft ? c.aimL : c.aimR;
  if (c.hasTarget) copy3(dir, c.target);
  else set3(dir, useLeft ? 0.2 : -0.2, -0.25, 1);
  // jab: the arm thrusts a little further along the line each time
  dir[1] += 0.25 * j;
  o[useLeft ? PK.aimL : PK.aimR] += e;
  o[PK.reach] += (0.6 + 0.4 * j) * e;
  // the other paw goes to the hip
  if (!c.traits.wings && c.kind !== 'badger') {
    if (useLeft) {
      o[PK.armRRaise] += 35 * DEG * e;
      o[PK.armRSwing] -= 20 * DEG * e;
    } else {
      o[PK.armLRaise] += 35 * DEG * e;
      o[PK.armLSwing] -= 20 * DEG * e;
    }
  }
}

function clap(c: ReactionCtx, o: Pose): void {
  const e = env(c.t, 0, c.dur, 0.15, 0.25) * c.I;
  const f = 4.2 + c.seed * 0.8;
  const ph = c.t * f * TAU + c.seed * 6;
  const apart = 0.5 + 0.5 * Math.cos(ph);
  const hit = Math.pow(1 - apart, 6);
  if (c.traits.wings) {
    const flap = (20 + 55 * apart) * DEG * e;
    o[PK.armLRaise] += flap;
    o[PK.armRRaise] += flap;
    o[PK.beak] += 0.35 * e;
  } else if (c.kind === 'badger') {
    // a critic's golf clap: pencil taps the notebook, approving nods
    o[PK.handR] += (0.5 - 0.5 * Math.cos(ph * 0.75)) * 0.5 * e;
    o[PK.armRSwing] += 10 * DEG * apart * e;
    o[PK.nod] += 5 * DEG * Math.sin(ph * 0.375) * e;
  } else {
    arms(o, 56 * DEG * e, (-18 - 46 * (1 - apart)) * DEG * e);
    o[PK.reach] += 0.35 * e;
  }
  o[PK.squash] += 0.035 * hit * e;
  o[PK.y] += 0.0012 * hit * e;
  o[PK.lidLow] += (c.kind === 'badger' ? 0.3 : 0.55) * e;
  o[PK.mouth] += (c.kind === 'badger' ? 0 : 0.45) * e;
  o[PK.earPerk] += 0.3 * e;
  o[PK.tailWag] += Math.sin(c.t * 13) * 0.45 * e;
  o[PK.nod] += (3 * Math.sin(ph) - 7) * DEG * e;
  o[PK.override] += 0.3 * e;
}

function cheer(c: ReactionCtx, o: Pose): void {
  const e = env(c.t, 0, c.dur, 0.12, 0.3) * c.I;
  const hopT = 0.5;
  const k = (c.t + c.seed * 0.2) / hopT;
  const f = k - Math.floor(k);
  const H = 0.017 * c.traits.hop * c.I;
  let y = 0;
  let sq = 0;
  if (c.t < c.dur - 0.3) {
    if (f < 0.18) sq = -0.12 * bump(f, 0, 0.36);
    else if (f < 0.86) {
      const a = seg(f, 0.18, 0.86);
      y = H * 4 * a * (1 - a);
      sq = 0.12 * (1 - a) - 0.02;
    } else sq = -0.14 * bump(f, 0.86, 1.14);
  }
  o[PK.y] += y;
  o[PK.squash] += sq * e;
  const wave = Math.sin(c.t * 12) * 0.25;
  if (c.traits.wings) {
    const flap = (35 + 50 * (0.5 + 0.5 * Math.sin(c.t * 30))) * DEG * e;
    o[PK.armLRaise] += flap;
    o[PK.armRRaise] += flap;
  } else {
    o[PK.aimL] += e;
    o[PK.aimR] += e;
    set3(c.aimL, 1, 0.62 + wave, 0.22);
    set3(c.aimR, -1, 0.62 - wave, 0.22);
    o[PK.reach] += e;
    if (c.kind === 'badger') o[PK.notebook] += 0.3 * e;
  }
  o[PK.override] += 0.45 * e;
  o[PK.nod] -= 12 * DEG * e;
  o[PK.mouth] += 0.8 * e;
  o[PK.beak] += (0.5 + 0.5 * Math.sin(c.t * 22)) * e;
  o[PK.lidLow] += 0.6 * e;
  o[PK.earPerk] += 0.5 * e;
  o[PK.tailWag] += Math.sin(c.t * 16) * 0.6 * e;
}

function giggle(c: ReactionCtx, o: Pose): void {
  const e = env(c.t, 0, c.dur, 0.12, 0.3) * c.I;
  const sh = Math.sin(c.t * TAU * 8.5);
  const bob = Math.sin(c.t * TAU * 4.25);
  o[PK.roll] += 2.6 * DEG * sh * e;
  o[PK.squash] += 0.022 * Math.abs(sh) * e;
  o[PK.y] += 0.001 * Math.abs(bob) * e;
  o[PK.lidLow] += 0.9 * e;
  o[PK.lidClose] += 0.32 * e;
  o[PK.nod] += (5 + 4 * bob) * DEG * e;
  o[PK.tilt] += 9 * DEG * e;
  o[PK.tailWag] += Math.sin(c.t * 15) * 0.5 * e;
  if (c.traits.wings) {
    o[PK.beak] += (0.5 + 0.5 * Math.sin(c.t * TAU * 11)) * e;
    o[PK.armLSwing] += 25 * DEG * e;
    o[PK.armRSwing] += 25 * DEG * e;
  } else if (c.kind === 'badger') {
    o[PK.notebook] += 0.55 * e;
    o[PK.aimR] += 0.8 * e;
    set3(c.aimR, -0.45, 0.55, 0.7);
  } else {
    o[PK.aimL] += 0.95 * e;
    o[PK.aimR] += 0.95 * e;
    set3(c.aimL, -0.35, 0.32, 0.88);
    set3(c.aimR, 0.35, 0.32, 0.88);
    o[PK.reach] += 0.7 * e;
    o[PK.mouth] += 0.3 * e;
  }
}

function blushScribble(c: ReactionCtx, o: Pose): void {
  const e = env(c.t, 0, c.dur, 0.25, 0.35) * c.I;
  o[PK.blush] += e;
  o[PK.ears] += 0.6 * e;
  if (c.kind === 'badger') {
    // buries his face in the notebook, scribbling furiously; peeks over the top now and then
    const cyc = (c.t + c.seed * 1.9) % 1.9;
    const peek = env(cyc, 1.15, 1.8, 0.12, 0.15);
    // notebook held up under his snout like a menu to hide behind; the pencil hand scribbles on it
    o[PK.aimL] += e;
    o[PK.aimR] += e;
    set3(c.aimL, -0.2, 0.21, 0.96);
    set3(c.aimR, 0.25, 0.26, 0.93);
    o[PK.reach] += 0.85 * e;
    o[PK.handL] += 0.9 * e;
    o[PK.scribble] += e * (1 - 0.7 * peek);
    o[PK.override] += e;
    o[PK.nod] += (17 - 14 * peek) * DEG * e;
    o[PK.turn] += 5 * DEG * e;
    o[PK.tilt] += 5 * DEG * e;
    o[PK.eyeAway] += 0.7 * (1 - peek) * e;
    o[PK.lidClose] += (0.3 - 0.25 * peek) * e;
    o[PK.squash] -= 0.03 * e;
    o[PK.lean] += 4 * DEG * e;
  } else if (c.traits.wings) {
    // shy magpie: hides behind a wing, peeking
    o[PK.armRSwing] += 70 * DEG * e;
    o[PK.armRRaise] += 35 * DEG * e;
    o[PK.eyeAway] += 0.8 * e;
    o[PK.tilt] += 12 * DEG * Math.sin(c.t * 2.2) * e;
    o[PK.lidClose] += 0.25 * e;
  } else {
    // shy: paws to the face, swaying
    o[PK.aimL] += e;
    o[PK.aimR] += e;
    set3(c.aimL, 0.42, 0.52, 0.74);
    set3(c.aimR, -0.42, 0.52, 0.74);
    o[PK.reach] += 0.5 * e;
    o[PK.eyeAway] += 0.8 * e;
    o[PK.tilt] += 12 * DEG * Math.sin(c.t * 2.2) * e;
    o[PK.roll] += 3 * DEG * Math.sin(c.t * 2.2) * e;
    o[PK.lidClose] += 0.25 * e;
  }
}

function hop(c: ReactionCtx, o: Pose): void {
  const T0 = HOP.takeoff * c.dur;
  const T1 = HOP.land * c.dur;
  const crouch = bump(c.t, T0 - 0.13, T0 + 0.03);
  const air = c.t > T0 && c.t < T1 ? seg(c.t, T0, T1) : 0;
  const land = bump(c.t, T1 - 0.02, T1 + 0.17);
  o[PK.squash] += -0.17 * crouch + (air > 0 ? 0.13 * (1 - air) : 0) - 0.2 * land;
  const inAir = env(c.t, T0 - 0.03, T1 + 0.04, 0.06, 0.08);
  o[PK.lean] += 12 * DEG * inAir - 6 * DEG * land;
  o[PK.wide] += 0.4 * inAir;
  o[PK.mouth] += 0.35 * inAir;
  o[PK.beak] += 0.5 * inAir;
  o[PK.tailLift] += 0.6 * inAir;
  if (c.traits.wings) {
    const flap = (30 + 50 * (0.5 + 0.5 * Math.sin(c.t * 42))) * DEG * inAir;
    o[PK.armLRaise] += flap;
    o[PK.armRRaise] += flap;
  } else {
    arms(o, -20 * DEG * crouch, 55 * DEG * inAir);
  }
  // ta-da on arrival
  const tada = env(c.t, HOP.faceEnd * c.dur - 0.05, c.dur, 0.08, 0.15);
  if (!c.traits.wings && c.kind !== 'badger') arms(o, 20 * DEG * tada, 70 * DEG * tada);
  o[PK.lidLow] += 0.5 * tada;
  o[PK.mouth] += 0.3 * tada;
}

function bow(c: ReactionCtx, o: Pose): void {
  const e = env(c.t, 0, c.dur, 0.4, 0.5) * c.I;
  o[PK.lean] += 32 * DEG * e;
  o[PK.override] += 0.85 * e;
  o[PK.nod] += 22 * DEG * e;
  o[PK.lidClose] += 0.75 * env(c.t, 0.25, c.dur - 0.3, 0.2, 0.2);
  o[PK.lidLow] += 0.45 * env(c.t, c.dur * 0.6, c.dur, 0.15, 0.2);
  if (c.traits.wings) {
    o[PK.armLRaise] += 70 * DEG * e;
    o[PK.armRRaise] += 70 * DEG * e;
    o[PK.armLSwing] -= 20 * DEG * e;
    o[PK.armRSwing] -= 20 * DEG * e;
  } else if (c.kind === 'badger') {
    o[PK.armLRaise] += 50 * DEG * e; // notebook flourish
    o[PK.armLSwing] -= 25 * DEG * e;
  } else {
    o[PK.aimR] += e;
    set3(c.aimR, 0.62, -0.42, 0.66);
    o[PK.armLRaise] += 58 * DEG * e;
    o[PK.armLSwing] -= 12 * DEG * e;
  }
}
