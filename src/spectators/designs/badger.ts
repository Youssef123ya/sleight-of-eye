// Sir Brock, badger critic (≈13 cm): grey pear body in a black waistcoat with brass buttons, red bow tie,
// white face stripe between black eye bands, heavy "unimpressed" lids, a brass monocle on his right eye,
// a red notebook in his left hand and a pencil in his right.
import { PAL } from '../../art/palette.js';
import { PuppetBuilder, add, alignY, alignZ, norm, offset, prim, type V3 } from '../builder.js';
import { DEFAULT_TRAITS, FELT_GAIN, GLOSS_GAIN, LIGHT_LIFT, addBlush, addEyes, blushPoint, addMouth, mx, standardBones, type PuppetDesign } from './common.js';
import { DEG } from '../math.js';

export const BROCK_NOTEBOOK_ROT: V3 = [-0.55, -0.32, 0.05];

export function buildBadger(): PuppetDesign {
  const b = new PuppetBuilder();
  b.gain = FELT_GAIN;
  b.lightLift = LIGHT_LIFT;
  const G = PAL.badgerGrey;
  const W = PAL.badgerWhite;
  const K = PAL.badgerBlack;
  const H: V3 = [0, 0.099, 0.006];
  const HR: V3 = [0.036, 0.031, 0.033];
  const earBase: V3 = [0.0255, 0.1215, -0.004];
  const CB: V3 = [0.0215, 0.0872, 0.0125];
  const CBR: V3 = [0.0158, 0.0146, 0.0205];
  const BD: V3 = [0.45, -0.12, 0.88];
  const cheek = blushPoint(CB, CBR, BD);
  const handL: V3 = [0.0175, 0.05, 0.03];
  const handR: V3 = [-0.0145, 0.052, 0.031];

  standardBones(b, {
    chest: [0, 0.061, 0.002],
    head: [0, 0.071, 0.003],
    earL: earBase,
    mouth: [0, 0.0818, 0.0445],
    jaw: [0, 0.083, 0.035],
    cheekL: cheek,
    armL: [0.0235, 0.062, 0.004],
    handL,
    armR: [-0.0235, 0.062, 0.004],
    handR,
    tail: [0, 0.018, -0.025],
    nose: [0, 0.0925, 0.0495],
  });

  // feet, body, waistcoat with brass buttons, red bow tie, stubby tail
  for (const sx of [1, -1]) b.felt('root', prim.sphere(14, 10), K, { p: [0.0135 * sx, 0.006, 0.006], s: [0.0105, 0.0065, 0.014] });
  b.felt('body', prim.sphere(28, 20), G, { p: [0, 0.035, 0], s: [0.03, 0.0335, 0.0265] });
  b.felt('body', prim.sphere(22, 16), G, { p: [0, 0.056, 0.002], s: [0.0235, 0.018, 0.0205] });
  b.felt('body', prim.sphere(22, 16), K, { p: [0, 0.036, 0.0115], s: [0.021, 0.025, 0.0175] });
  for (const [y, z] of [[0.044, 0.0284], [0.0345, 0.0293], [0.025, 0.0274]] as const) {
    b.gloss('body', prim.sphere(10, 8), PAL.brass, { p: [0, y, z], s: 0.002, gain: GLOSS_GAIN });
  }
  b.felt('chest', prim.sphere(12, 10), PAL.notebookRed, { p: [0, 0.0655, 0.0215], s: [0.0034, 0.003, 0.0026] });
  for (const sx of [1, -1]) {
    b.felt('chest', prim.cone(0.0058, 0.0105, 12), PAL.notebookRed, {
      p: [0.0058 * sx, 0.0655, 0.0205],
      r: alignY([-sx, 0, 0]),
      s: [1, 1, 0.42],
    });
  }
  b.felt('tail', prim.sphere(12, 10), G, { p: [0, 0.018, -0.0265], s: [0.0085, 0.0075, 0.009] });

  // head: black base (the eye bands), white centre stripe, white cheeks, white snout, black nose
  b.felt('head', prim.sphere(32, 24), K, { p: H, s: HR });
  b.felt('head', prim.sphere(28, 22), W, { p: [0, 0.1, 0.006], s: [0.0105, 0.0322, 0.0342] });
  for (const sx of [1, -1]) b.felt('head', prim.sphere(20, 14), W, { p: [0.0215 * sx, 0.0872, 0.0125], s: [0.0158, 0.0146, 0.0205] });
  b.felt('head', prim.sphere(22, 16), W, { p: [0, 0.0905, 0.033], r: [0.1, 0, 0], s: [0.0118, 0.0108, 0.0175] });
  b.gloss('nose', prim.sphere(14, 10), 0x141418, { p: [0, 0.0925, 0.0495], s: [0.0068, 0.0052, 0.0048] });
  // stern sewn mouth line
  b.felt('head', prim.capsule(0.0007, 0.0062, 3, 6), K, { p: [0, 0.0846, 0.0452], r: [0, 0, Math.PI / 2] });
  addMouth(b, [0, 0.0818, 0.0445], 0.0066);

  // heavy-lidded eyes on the black bands
  const eyeDir: V3 = [0.52, 0.18, 0.84];
  const eyes = addEyes(b, {
    head: H,
    radii: HR,
    dir: eyeDir,
    r: 0.0105,
    inset: 0.5,
    pupil: 0.5,
    lid: K,
    low: K,
    upperEdge: 27,
    lowerEdge: -44,
  });
  addBlush(b, CB, CBR, BD, 0.42, PAL.blush);

  // monocle on his right eye (-X): brass ring + a short chain
  const dR = norm(mx(eyeDir));
  const ring = add(eyes.eyeR, dR, 0.0105 * 0.6);
  b.gloss('head', prim.torus(0.0105 * 1.2, 0.0014, 8, 36), PAL.brass, { p: ring, r: alignZ(dR), gain: GLOSS_GAIN });
  for (let i = 1; i <= 4; i++) {
    b.gloss('head', prim.sphere(6, 5), PAL.brass, { p: add(ring, [0.0012 * i, -0.0125 - 0.0028 * i, -0.0016 * i]), s: 0.0009, gain: GLOSS_GAIN });
  }

  // small round ears, black with white tips
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    const base: V3 = [earBase[0] * sx, earBase[1], earBase[2]];
    b.felt(`ear${side}`, prim.sphere(14, 10), K, { p: add(base, [0.002 * sx, 0.0045, 0]), s: [0.0088, 0.0082, 0.0048] });
    b.felt(`ear${side}`, prim.sphere(12, 8), W, { p: add(base, [0.0034 * sx, 0.0112, -0.0004]), s: [0.0054, 0.0027, 0.0041] });
  }

  // arms: grey sleeves, black paws
  for (const [side, sh, hand] of [['L', [0.0235, 0.062, 0.004], handL], ['R', [-0.0235, 0.062, 0.004], handR]] as const) {
    const d: V3 = [hand[0] - sh[0], hand[1] - sh[1], hand[2] - sh[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    b.felt(`arm${side}`, prim.capsule(0.0068, Math.max(0.001, len - 0.008), 4, 12), G, { p: add(sh as V3, d, 0.5), r: alignY(d) });
    b.felt(`hand${side}`, prim.sphere(12, 10), K, { p: hand, s: [0.0068, 0.0064, 0.0068] });
  }

  // red notebook in the left hand: cover, cream pages, back cover, spine
  const nb: V3 = [0.0112, 0.0565, 0.0372];
  const nr = BROCK_NOTEBOOK_ROT;
  b.felt('handL', prim.box(0.0225, 0.0285, 0.0016), PAL.notebookRed, { p: nb, r: nr });
  b.felt('handL', prim.box(0.0208, 0.0268, 0.0034), 0xf6efdc, { p: offset(nb, nr, [0.0004, 0, -0.0025]), r: nr });
  b.felt('handL', prim.box(0.0225, 0.0285, 0.0016), PAL.notebookRed, { p: offset(nb, nr, [0, 0, -0.005]), r: nr });
  b.felt('handL', prim.box(0.0026, 0.0285, 0.0066), 0x8e2b2b, { p: offset(nb, nr, [-0.0112, 0, -0.0025]), r: nr });
  b.felt('handL', prim.box(0.0018, 0.0012, 0.0018), PAL.gold, { p: offset(nb, nr, [0.006, 0.0144, 0.0004]), r: nr });

  // pencil in the right hand, tip towards the notebook
  const pd = norm([1, 0.18, 0.32]);
  const pr = alignY(pd);
  const pc = add(handR, pd, 0.004);
  b.felt('handR', prim.cyl(0.0017, 0.0017, 0.024, 6), 0xf2c230, { p: pc, r: pr });
  b.felt('handR', prim.cone(0.0017, 0.0042, 6), 0xe8c89a, { p: add(pc, pd, 0.0141), r: pr });
  b.felt('handR', prim.cone(0.0007, 0.0016, 6), 0x2c2c30, { p: add(pc, pd, 0.0158), r: pr });
  b.gloss('handR', prim.cyl(0.00185, 0.00185, 0.0028, 8), 0xb8bcc8, { p: add(pc, pd, -0.0134), r: pr, gain: GLOSS_GAIN });
  b.felt('handR', prim.cyl(0.0017, 0.0017, 0.003, 8), 0xf09aa4, { p: add(pc, pd, -0.0161), r: pr });

  const { felt, gloss } = b.build();
  return {
    kind: 'badger',
    key: 'badger',
    defs: b.bones,
    felt,
    gloss,
    headRadius: 0.035,
    height: 0.13,
    eyeL: eyes.eyeL,
    eyeR: eyes.eyeR,
    eyeRadius: 0.0105,
    eyeYaw: eyes.eyeYaw,
    lidClose: eyes.lidClose,
    lidRise: eyes.lidRise,
    glyphY: 0.078,
    toeZ: 0.02,
    restLift: 0,
    anchors: {
      eyes: { bone: 'head', p: [0, eyes.eyeL[1], eyes.eyeL[2] + 0.004] },
      head: { bone: 'head', p: H },
      ear: { bone: 'earL', p: add(earBase, [0.002, 0.005, 0]) },
      hand: { bone: 'handR', p: handR },
      notebook: { bone: 'handL', p: nb },
      beak: { bone: 'head', p: [0, 0.0925, 0.0545] },
      hatTop: { bone: 'head', p: [0, 0.131, 0.006] },
    },
    traits: { ...DEFAULT_TRAITS, stiff: 0.85, pompous: 4 * DEG, hop: 0.75 },
  };
}
