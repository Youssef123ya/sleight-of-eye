// Rabbit helper (≈8 cm) peeking out of an upside-down black top hat (Assist mode). The hat hangs off the
// static 'hat' bone; the rabbit's own root bone rises out of it, hops away and dives back in.
import { PAL } from '../../art/palette.js';
import { PuppetBuilder, add, alignY, flipInside, norm, prim, type V3 } from '../builder.js';
import { DEFAULT_TRAITS, FELT_GAIN, GLOSS_GAIN, LIGHT_LIFT, EYE_WHITE_GAIN, addBlush, addEyes, blushPoint, addMouth, standardBones, type PuppetDesign } from './common.js';

export const HAT = { height: 0.05, radius: 0.0262, floor: 0.012, brim: 0.0413 } as const;

export function buildRabbit(): PuppetDesign {
  const b = new PuppetBuilder();
  b.gain = FELT_GAIN;
  b.lightLift = LIGHT_LIFT;
  const Wt = PAL.rabbitWhite;
  const PINK = 0xf4b3c1;
  const H: V3 = [0, 0.057, 0.004];
  const HR: V3 = [0.0245, 0.0225, 0.023];
  const earBase: V3 = [0.0088, 0.0762, -0.003];
  const earAxis = norm([0.2, 1, -0.12]);
  const CR: V3 = [0.0155, 0.0495, 0.011];
  const CRR: V3 = [0.0115, 0.0095, 0.011];
  const BD: V3 = [0.5, -0.1, 0.86];
  const cheek = blushPoint(CR, CRR, BD);
  const handL: V3 = [0.0172, 0.0405, 0.0272];

  standardBones(b, {
    chest: [0, 0.036, 0.002],
    head: [0, 0.041, 0.003],
    earL: earBase,
    mouth: [0, 0.0448, 0.0262],
    jaw: [0, 0.046, 0.022],
    cheekL: cheek,
    armL: [0.0135, 0.036, 0.006],
    handL,
    tail: [0, 0.016, -0.017],
    nose: [0, 0.0535, 0.0278],
  });

  // ---- the top hat (static bone): satin-black crown, dark inside, brim, red band with a bow
  const Kh = PAL.hatBlack;
  b.felt('hat', prim.cyl(HAT.radius - 0.0004, 0.0274, HAT.height, 36, true), Kh, { p: [0, HAT.height / 2, 0] });
  b.felt('hat', flipInside(prim.cyl(0.0246, 0.026, HAT.height - 0.001, 36, true)), 0x09090c, { p: [0, HAT.height / 2 + 0.0005, 0] });
  b.felt('hat', prim.cyl(0.0247, 0.0247, 0.002, 36), 0x0c0c10, { p: [0, HAT.floor - 0.001, 0] });
  b.felt('hat', prim.torus(0.0335, 0.0078, 10, 48), Kh, { p: [0, HAT.height + 0.0004, 0], r: [Math.PI / 2, 0, 0], s: [1, 1, 0.3] });
  b.felt('hat', prim.cyl(0.0266, 0.0268, 0.0075, 36, true), PAL.clothRed, { p: [0, 0.0425, 0] });
  b.felt('hat', prim.sphere(10, 8), PAL.clothRed, { p: [0.0186, 0.0425, 0.0192], s: [0.0026, 0.0034, 0.0022] });
  for (const sy of [1, -1]) {
    b.felt('hat', prim.cone(0.003, 0.0062, 10), PAL.clothRed, { p: [0.0186 + 0.0026, 0.0425 + 0.0026 * sy, 0.0192 + 0.0022], r: alignY([0.4, -sy, 0.5]), s: [1, 1, 0.45] });
  }

  // ---- rabbit: big feet, round body, cream belly, pom-pom tail
  for (const sx of [1, -1]) b.felt('root', prim.sphere(14, 10), Wt, { p: [0.0085 * sx, 0.0045, 0.006], s: [0.0068, 0.0045, 0.0125] });
  b.felt('body', prim.sphere(24, 18), Wt, { p: [0, 0.0225, 0], s: [0.0185, 0.021, 0.0175] });
  b.felt('body', prim.sphere(18, 12), 0xfffaf0, { p: [0, 0.021, 0.0082], s: [0.013, 0.016, 0.011] });
  b.felt('tail', prim.sphere(12, 10), 0xffffff, { p: [0, 0.016, -0.0185], s: 0.0072 });

  // head, puffy cheeks, muzzle puffs, pink nose, buck teeth, hidden O-mouth
  b.felt('head', prim.sphere(30, 22), Wt, { p: H, s: HR });
  for (const sx of [1, -1]) {
    b.felt('head', prim.sphere(16, 12), Wt, { p: [0.0155 * sx, 0.0495, 0.011], s: [0.0115, 0.0095, 0.011] });
    b.felt('head', prim.sphere(14, 10), 0xfffdf8, { p: [0.0052 * sx, 0.0488, 0.0222], s: [0.0068, 0.0058, 0.0058] });
    b.gloss('head', prim.box(0.0021, 0.0038, 0.0012), 0xffffff, { p: [0.00115 * sx, 0.0432, 0.0263], gain: EYE_WHITE_GAIN });
  }
  b.gloss('nose', prim.sphere(12, 10), 0xf08ca0, { p: [0, 0.0535, 0.0278], s: [0.0042, 0.0032, 0.003], gain: GLOSS_GAIN });
  addMouth(b, [0, 0.0448, 0.0262], 0.005);

  const eyes = addEyes(b, {
    head: H,
    radii: HR,
    dir: [0.56, 0.12, 0.82],
    r: 0.0093,
    inset: 0.45,
    pupil: 0.52,
    lid: Wt,
    low: Wt,
    upperEdge: 58,
    lowerEdge: -44,
  });
  addBlush(b, CR, CRR, BD, 0.45, PAL.blush);

  // long ears with pink insides
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    const base: V3 = [earBase[0] * sx, earBase[1], earBase[2]];
    const axis: V3 = [earAxis[0] * sx, earAxis[1], earAxis[2]];
    const r = alignY(axis);
    b.felt(`ear${side}`, prim.capsule(0.0058, 0.027, 5, 14), Wt, { p: add(base, axis, 0.0155), r, s: [1, 1, 0.48] });
    b.felt(`ear${side}`, prim.capsule(0.0034, 0.02, 4, 12), PINK, { p: add(add(base, axis, 0.0175), [0, 0, 0.0022]), r, s: [1, 1, 0.3] });
  }

  // little arms; paws rest on the brim when peeking
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    const sh: V3 = [0.0135 * sx, 0.036, 0.006];
    const paw: V3 = [handL[0] * sx, handL[1], handL[2]];
    const d: V3 = [paw[0] - sh[0], paw[1] - sh[1], paw[2] - sh[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    b.felt(`arm${side}`, prim.capsule(0.0045, Math.max(0.001, len - 0.005), 4, 10), Wt, { p: add(sh, d, 0.5), r: alignY(d) });
    b.felt(`hand${side}`, prim.sphere(12, 10), 0xfffdf8, { p: paw, s: [0.0052, 0.0046, 0.0058] });
  }

  const { felt, gloss } = b.build();
  return {
    kind: 'rabbit',
    key: 'rabbit',
    defs: b.bones,
    felt,
    gloss,
    headRadius: 0.024,
    height: 0.08,
    eyeL: eyes.eyeL,
    eyeR: eyes.eyeR,
    eyeRadius: 0.0093,
    eyeYaw: eyes.eyeYaw,
    lidClose: eyes.lidClose,
    lidRise: eyes.lidRise,
    glyphY: 0.09,
    toeZ: 0.018,
    restLift: HAT.floor,
    anchors: {
      eyes: { bone: 'head', p: [0, eyes.eyeL[1], eyes.eyeL[2] + 0.004] },
      head: { bone: 'head', p: H },
      ear: { bone: 'earL', p: add(earBase, earAxis, 0.02) },
      hand: { bone: 'handR', p: [-handL[0], handL[1], handL[2]] },
      notebook: { bone: 'chest', p: [0, 0.03, 0.018] },
      beak: { bone: 'nose', p: [0, 0.0535, 0.031] },
      hatTop: { bone: 'hat', p: [0, HAT.height, 0] },
    },
    traits: { ...DEFAULT_TRAITS, hat: true, earFlop: 2.4, stiff: 1.1, hop: 1.15 },
  };
}
