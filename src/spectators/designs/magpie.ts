// Magpie (≈10 cm): black and white, teal wing sheen, short glossy beak that opens, long iridescent tail,
// two cheeky crown feathers (driven by the ear bones), thin legs with little toes.
import { PAL } from '../../art/palette.js';
import { PuppetBuilder, add, alignY, norm, prim, type V3 } from '../builder.js';
import { DEFAULT_TRAITS, FELT_GAIN, LIGHT_LIFT, addBlush, addEyes, blushPoint, standardBones, type PuppetDesign } from './common.js';

export function buildMagpie(): PuppetDesign {
  const b = new PuppetBuilder();
  b.gain = FELT_GAIN;
  b.lightLift = LIGHT_LIFT;
  // a blue-black charcoal: pure black felt reads as a hole under the café lamp
  const K = 0x2b2d39;
  const W = PAL.magpieWhite;
  const T = PAL.magpieTeal;
  const LEG = 0x34343c;
  const H: V3 = [0, 0.0715, 0.009];
  const HR: V3 = [0.0255, 0.0245, 0.025];
  const crest: V3 = [0.004, 0.094, 0.006];
  const BD: V3 = [0.55, -0.34, 0.76];
  const cheek = blushPoint(H, HR, BD);

  standardBones(b, {
    chest: [0, 0.044, 0.003],
    head: [0, 0.05, 0.006],
    earL: crest,
    mouth: [0, 0.064, 0.031],
    jaw: [0, 0.0668, 0.0285],
    cheekL: cheek,
    armL: [0.0168, 0.046, 0.0],
    handL: [0.0185, 0.022, -0.026],
    tail: [0, 0.02, -0.02],
    nose: [0, 0.0695, 0.033],
  });

  // legs and toes
  for (const sx of [1, -1]) {
    const x = 0.0075 * sx;
    b.felt('root', prim.cyl(0.0016, 0.0014, 0.013, 8), LEG, { p: [x, 0.0072, 0.002] });
    for (const a of [-0.45, 0, 0.45]) {
      b.felt('root', prim.capsule(0.0011, 0.0055, 2, 6), LEG, { p: [x + Math.sin(a) * 0.0035, 0.0011, 0.002 + Math.cos(a) * 0.0035], r: alignY([Math.sin(a), 0, Math.cos(a)]) });
    }
    b.felt('root', prim.capsule(0.0011, 0.004, 2, 6), LEG, { p: [x, 0.0011, -0.0012], r: alignY([0, 0, -1]) });
  }

  // body (tilted, chest up) + white belly
  b.felt('body', prim.sphere(26, 18), K, { p: [0, 0.031, -0.002], r: [-0.3, 0, 0], s: [0.0195, 0.0225, 0.0235] });
  b.felt('body', prim.sphere(20, 14), W, { p: [0, 0.0255, 0.0082], s: [0.0176, 0.0178, 0.0158] });

  // long tail with teal sheen
  const tb: V3 = [0, 0.02, -0.02];
  const td = norm([0, -0.38, -1]);
  const up = norm([0, 1, -0.38]);
  b.felt('tail', prim.sphere(18, 12), K, { p: add(tb, td, 0.03), r: alignY(td), s: [0.0085, 0.032, 0.0032] });
  b.felt('tail', prim.sphere(16, 10), T, { p: add(add(tb, td, 0.033), up, 0.0013), r: alignY(td), s: [0.006, 0.026, 0.0031] });

  // wings: black with a white shoulder patch and teal primaries
  const wd = norm([0, -0.45, -1]);
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    const sh: V3 = [0.0168 * sx, 0.046, 0];
    const r = alignY(wd);
    b.felt(`arm${side}`, prim.sphere(18, 12), K, { p: add(add(sh, wd, 0.016), [0.0022 * sx, 0, 0]), r, s: [0.0055, 0.0235, 0.0152] });
    b.felt(`arm${side}`, prim.sphere(14, 10), W, { p: add(add(sh, wd, 0.0068), [0.0038 * sx, 0.0016, 0.0035]), r, s: [0.0046, 0.0135, 0.0105] });
    b.felt(`arm${side}`, prim.sphere(14, 10), T, { p: add(add(sh, wd, 0.0275), [0.0034 * sx, 0, 0]), r, s: [0.0043, 0.0125, 0.0105] });
  }

  // head, crown feathers, glossy beak (upper on the head, lower on the jaw)
  b.felt('head', prim.sphere(30, 22), K, { p: H, s: HR });
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    b.felt(`ear${side}`, prim.cone(0.0038, 0.0135, 10), K, { p: [crest[0] * sx + 0.0012 * sx, crest[1] + 0.005, crest[2] - 0.001], r: alignY([0.3 * sx, 1, -0.45]), s: [1, 1, 0.5] });
  }
  const ud = norm([0, -0.16, 1]);
  b.gloss('head', prim.cone(0.0064, 0.0182, 16), 0x5a5c68, { p: add([0, 0.0688, 0.03], ud, 0.0091), r: alignY(ud), s: [1, 1, 0.74], gain: 1.6 });
  const ld = norm([0, -0.34, 1]);
  b.gloss('jaw', prim.cone(0.0047, 0.0118, 14), 0x4a4c57, { p: add([0, 0.0663, 0.0288], ld, 0.0059), r: alignY(ld), s: [1, 1, 0.62], gain: 1.5 });

  const eyes = addEyes(b, {
    head: H,
    radii: HR,
    dir: [0.62, 0.1, 0.78],
    r: 0.0099,
    inset: 0.5,
    pupil: 0.5,
    lid: K,
    low: K,
    upperEdge: 56,
    lowerEdge: -44,
  });
  addBlush(b, H, HR, BD, 0.24, PAL.blush);

  const { felt, gloss } = b.build();
  return {
    kind: 'magpie',
    key: 'magpie',
    defs: b.bones,
    felt,
    gloss,
    headRadius: 0.026,
    height: 0.096,
    eyeL: eyes.eyeL,
    eyeR: eyes.eyeR,
    eyeRadius: 0.0099,
    eyeYaw: eyes.eyeYaw,
    lidClose: eyes.lidClose,
    lidRise: eyes.lidRise,
    glyphY: 0.066,
    toeZ: 0.012,
    restLift: 0,
    anchors: {
      eyes: { bone: 'head', p: [0, eyes.eyeL[1], eyes.eyeL[2] + 0.004] },
      head: { bone: 'head', p: H },
      ear: { bone: 'earL', p: [crest[0], crest[1] + 0.004, crest[2]] },
      hand: { bone: 'handR', p: [-0.0185, 0.022, -0.026] },
      notebook: { bone: 'chest', p: [0, 0.034, 0.02] },
      beak: { bone: 'head', p: [0, 0.0668, 0.0445] },
      hatTop: { bone: 'head', p: [0, 0.097, 0.009] },
    },
    traits: { ...DEFAULT_TRAITS, bird: true, wings: true, stiff: 1.3, earFlop: 0.6, tailFlop: 1.4, hop: 1.1 },
  };
}
