// Fox kit (≈9 cm): round orange body, big head, cream muzzle/cheeks/belly, dark-tipped triangular ears,
// bushy white-tipped tail. Three costume variants so the trio reads as three individuals.
import { PAL } from '../../art/palette.js';
import { PuppetBuilder, add, alignY, norm, prim, type V3 } from '../builder.js';
import { DEFAULT_TRAITS, FELT_GAIN, LIGHT_LIFT, addBlush, addEyes, blushPoint, addMouth, standardBones, type PuppetDesign } from './common.js';

const COSTUME = [0xc8413c, 0xe9b246, 0x5d86d8] as const;
const EAR_INNER = 0xf7d8c4;

export function buildFox(variant: number): PuppetDesign {
  const v = ((variant % 3) + 3) % 3;
  const b = new PuppetBuilder();
  b.gain = FELT_GAIN;
  b.lightLift = LIGHT_LIFT;
  const O = PAL.foxOrange;
  const C = PAL.foxCream;
  const D = PAL.foxDark;
  const H: V3 = [0, 0.066, 0.004];
  const HR: V3 = [0.0335, 0.0285, 0.0295];
  const earBase: V3 = [0.0185, 0.0862, -0.001];
  const earAxis = norm([0.42, 1, -0.07]);
  const CF: V3 = [0.0205, 0.0555, 0.0135];
  const CFR: V3 = [0.0145, 0.0115, 0.0135];
  const BD: V3 = [0.5, -0.08, 0.86];
  const cheek = blushPoint(CF, CFR, BD);

  standardBones(b, {
    chest: [0, 0.039, 0.001],
    head: [0, 0.046, 0.002],
    earL: earBase,
    mouth: [0, 0.0503, 0.0372],
    jaw: [0, 0.052, 0.03],
    cheekL: cheek,
    armL: [0.0165, 0.039, 0.004],
    handL: [0.0212, 0.0222, 0.0128],
    tail: [0.003, 0.012, -0.0165],
    nose: [0, 0.0597, 0.0412],
  });

  // feet ("socks") + body + cream belly + chin ruff
  for (const sx of [1, -1]) b.felt('root', prim.sphere(14, 10), D, { p: [0.0105 * sx, 0.0052, 0.0045], s: [0.0085, 0.0058, 0.0115] });
  b.felt('body', prim.sphere(26, 18), O, { p: [0, 0.0265, 0], s: [0.0215, 0.0245, 0.0195] });
  b.felt('body', prim.sphere(20, 14), C, { p: [0, 0.0245, 0.0105], s: [0.0145, 0.0185, 0.011] });
  b.felt('chest', prim.sphere(16, 12), C, { p: [0, 0.0425, 0.0115], s: [0.0125, 0.0085, 0.0085] });

  // head, cheek fluff, pointy cheek tufts, muzzle, nose, sewn "ω" smile, hidden O-mouth
  b.felt('head', prim.sphere(32, 24), O, { p: H, s: HR });
  for (const sx of [1, -1]) {
    b.felt('head', prim.sphere(18, 12), C, { p: [0.0205 * sx, 0.0555, 0.0135], s: [0.0145, 0.0115, 0.0135] });
    b.felt('head', prim.cone(0.0062, 0.013, 10), C, { p: [0.0335 * sx, 0.0512, 0.0065], r: alignY([sx, -0.5, 0.15]), s: [1, 1, 0.55] });
  }
  b.felt('head', prim.sphere(20, 14), C, { p: [0, 0.0565, 0.0255], r: [0.12, 0, 0], s: [0.0125, 0.0098, 0.0165] });
  b.gloss('nose', prim.sphere(14, 10), 0x1b1416, { p: [0, 0.0597, 0.0412], s: [0.0052, 0.004, 0.004] });
  for (const sx of [1, -1]) {
    b.felt('head', prim.torus(0.0034, 0.0007, 5, 14, Math.PI), D, { p: [0.0034 * sx, 0.0536, 0.0399], r: [0.35, 0, Math.PI] });
  }
  addMouth(b, [0, 0.0503, 0.0372], 0.0062);

  const eyes = addEyes(b, {
    head: H,
    radii: HR,
    dir: [0.55, 0.14, 0.82],
    r: 0.0108,
    inset: 0.45,
    pupil: 0.5,
    lid: O,
    low: O,
    upperEdge: 60,
    lowerEdge: -44,
  });
  addBlush(b, CF, CFR, BD, 0.42, PAL.blush);

  // ears: orange front, dark back, dark tip, cream inner
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    const base: V3 = [earBase[0] * sx, earBase[1], earBase[2]];
    const axis: V3 = [earAxis[0] * sx, earAxis[1], earAxis[2]];
    const r = alignY(axis);
    const h = 0.026;
    const R = 0.0118;
    const mid = add(base, axis, h / 2 - 0.0035);
    const apex = add(mid, axis, h / 2);
    const f = 0.42;
    b.felt(`ear${side}`, prim.cone(R, h, 16), O, { p: mid, r, s: [1, 1, 0.42] });
    b.felt(`ear${side}`, prim.cone(R * 0.97, h, 16), D, { p: add(mid, [0, 0, -0.0017]), r, s: [1, 1, 0.36] });
    b.felt(`ear${side}`, prim.cone(R * f * 1.1, h * f, 12), D, { p: add(apex, axis, (-h * f) / 2 + 0.0002), r, s: [1, 1, 0.5] });
    b.felt(`ear${side}`, prim.cone(0.0074, 0.0172, 12), EAR_INNER, {
      p: add(add(base, axis, 0.0172 / 2 - 0.0012), [0, 0, 0.0022]),
      r,
      s: [1, 1, 0.3],
    });
  }

  // arms with dark paws
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    const sh: V3 = [0.0165 * sx, 0.039, 0.004];
    const paw: V3 = [0.0212 * sx, 0.0222, 0.0128];
    const d: V3 = [paw[0] - sh[0], paw[1] - sh[1], paw[2] - sh[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    b.felt(`arm${side}`, prim.capsule(0.0052, Math.max(0.001, len - 0.006), 4, 12), O, { p: add(sh, d, 0.5), r: alignY(d) });
    b.felt(`hand${side}`, prim.sphere(12, 10), D, { p: paw, s: [0.0062, 0.0058, 0.0062] });
  }

  // bushy tail, white tip, peeking out on the puppet's left
  const tb: V3 = [0.003, 0.012, -0.0165];
  const td = norm([0.5, 0.62, -0.6]);
  b.felt('tail', prim.sphere(20, 14), O, { p: add(tb, td, 0.019), r: alignY(td), s: [0.0118, 0.0255, 0.0118] });
  b.felt('tail', prim.sphere(14, 10), 0xfbf3e6, { p: add(tb, td, 0.0405), r: alignY(td), s: [0.0088, 0.012, 0.0088] });

  // costume
  const K = COSTUME[v];
  if (v === 0) {
    // bandana: collar + front flap
    b.felt('chest', prim.torus(0.0152, 0.0032, 8, 28), K, { p: [0, 0.0448, 0.0012], r: [Math.PI / 2 + 0.12, 0, 0] });
    b.felt('chest', prim.cone(0.0098, 0.0155, 14), K, { p: [0, 0.0352, 0.0212], r: alignY([0, -1, 0.3]), s: [1, 1, 0.3] });
    b.felt('chest', prim.sphere(10, 8), K, { p: [0, 0.0425, 0.0205], s: [0.0042, 0.0034, 0.003] });
  } else if (v === 1) {
    // chunky scarf with a dangling end + cream forelock
    b.felt('chest', prim.torus(0.0168, 0.0052, 8, 28), K, { p: [0, 0.0418, 0.0016], r: [Math.PI / 2 + 0.16, 0, 0] });
    b.felt('chest', prim.capsule(0.0044, 0.017, 3, 10), K, { p: [-0.0092, 0.0315, 0.0198], r: [0.25, 0, 0.22], s: [1, 1, 0.55] });
    b.felt('chest', prim.capsule(0.0047, 0.0012, 3, 10), 0xfff1d8, { p: [-0.0112, 0.0225, 0.0216], r: [0.25, 0, 0.22], s: [1.05, 0.5, 0.6] });
    for (const [x, z, t] of [[0.003, 0.0215, -0.25], [-0.0035, 0.0205, 0.3]] as const) {
      b.felt('head', prim.cone(0.0045, 0.012, 10), O, { p: [x, 0.0935, z], r: [0.55, 0, t] });
    }
  } else {
    // a bow on the left ear
    const base: V3 = [earBase[0] + 0.004, earBase[1] + 0.006, earBase[2] + 0.0045];
    b.felt('earL', prim.sphere(10, 8), K, { p: base, s: 0.0029 });
    b.felt('earL', prim.cone(0.0048, 0.0085, 10), K, { p: add(base, [0.0042, 0.0012, 0]), r: alignY([-1, -0.25, 0]), s: [1, 1, 0.45] });
    b.felt('earL', prim.cone(0.0048, 0.0085, 10), K, { p: add(base, [-0.0042, -0.0012, 0]), r: alignY([1, 0.25, 0]), s: [1, 1, 0.45] });
  }

  const { felt, gloss } = b.build();
  const earMid = add(earBase, earAxis, 0.012);
  return {
    kind: 'fox',
    key: `fox:${v}`,
    defs: b.bones,
    felt,
    gloss,
    headRadius: 0.032,
    height: 0.0945,
    eyeL: eyes.eyeL,
    eyeR: eyes.eyeR,
    eyeRadius: 0.0108,
    eyeYaw: eyes.eyeYaw,
    lidClose: eyes.lidClose,
    lidRise: eyes.lidRise,
    glyphY: 0.077,
    toeZ: 0.016,
    restLift: 0,
    anchors: {
      eyes: { bone: 'head', p: [0, eyes.eyeL[1], eyes.eyeL[2] + 0.004] },
      head: { bone: 'head', p: H },
      ear: { bone: 'earL', p: earMid },
      hand: { bone: 'handR', p: [-0.0212, 0.0222, 0.0128] },
      notebook: { bone: 'chest', p: [0, 0.036, 0.02] },
      beak: { bone: 'head', p: [0, 0.0597, 0.0455] },
      hatTop: { bone: 'head', p: [0, 0.1, 0.004] },
    },
    traits: { ...DEFAULT_TRAITS },
  };
}
