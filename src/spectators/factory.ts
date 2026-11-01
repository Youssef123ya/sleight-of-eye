// Spectator factory (contracts.SpectatorFactory): fox kits, the magpie, Sir Brock and the hat rabbit.
//
// Cost: each puppet is 2 draw calls (felt + gloss SkinnedMeshes sharing one rigid skeleton, so ears, lids,
// pupils, arms, tail, notebook and pencil all move independently) + 1 eye glyph + 1 sight cone when shown.
// Geometry is shared per kind/variant, materials and the glyph atlas are shared by every instance.
// Per-frame work allocates nothing: the puppets compose their own bone matrices (matrixAutoUpdate = false on every
// node below `root`), see spectator.ts.
//
// Integration notes:
// - Place `root` at a seat (L.seats, feet on the riser, facing +Z) or, for the rabbit, on the tabletop. `root`
//   never moves; hops move the puppet inside it. Re-parent it whenever you like (the puppet notices).
// - The sight cone is a flat fan on the cloth from the riser's front edge (or the hat brim). It keeps itself at the
//   rig-local height CONE_Y = L.mat.top + 1.5 mm wherever `root` is parented (it measures against the StageRig
//   above it), so it always shows on top of the 6 mm velvet mat; there is nothing to lift.
// - `opts.seed` picks a fox costume (seed % 3: bandana, scarf + forelock, ear bow) and the idle rhythm;
//   `opts.scale` shrinks a kit (the smallest kit topples); `opts.accent` tints its glyph and cone.
// - `setSightHalfAngle(deg)` lets the drawn cone match Easy Audience's narrower rule (CFG.sightHalfAngleEasy).
// - The internal nodes' matrices are authoritative (matrixAutoUpdate = false): read world poses from anchors'
//   matrixWorld / the contract getters; do not move the puppet's own nodes.
import type { SpectatorFactory } from '../contracts.js';
import { PuppetSpectator } from './spectator.js';

export const spectatorFactory: SpectatorFactory = {
  create(kind, opts) {
    return new PuppetSpectator(kind, opts);
  },
};

export { PuppetSpectator };
export { CONE_LIFT, CONE_Y } from './spectator.js';
