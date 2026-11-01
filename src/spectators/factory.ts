// Spectator factory (contracts.SpectatorFactory): fox kits, the magpie, Sir Brock and the hat rabbit.
//
// Cost: each puppet is 2 draw calls (felt + gloss SkinnedMeshes sharing one rigid skeleton, so ears, lids,
// pupils, arms, tail, notebook and pencil all move independently) + 1 eye glyph + 1 sight cone when shown.
// Geometry is shared per kind/variant, materials and the glyph atlas are shared by every instance.
//
// Integration notes:
// - Place `root` at a seat (L.seats, feet on the riser, facing +Z) or, for the rabbit, on the tabletop. The
//   sight cone is drawn relative to that placement: from the riser's front edge (or the hat brim) on the
//   cloth at L.tableY + CONE_LIFT. `root` never moves; hops move the puppet inside it.
// - `opts.seed` picks a fox costume (seed % 3: bandana, scarf + forelock, ear bow) and the idle rhythm;
//   `opts.scale` shrinks a kit (the smallest kit topples); `opts.accent` tints its glyph and cone.
// - Extra (not in the contract): `PuppetSpectator.setSightHalfAngle(deg)` so the drawn cone can match Easy
//   Audience's narrower rule (CFG.sightHalfAngleEasy).
import type { SpectatorFactory } from '../contracts.js';
import { PuppetSpectator } from './spectator.js';

export const spectatorFactory: SpectatorFactory = {
  create(kind, opts) {
    return new PuppetSpectator(kind, opts);
  },
};

export { PuppetSpectator };
export { CONE_LIFT } from './spectator.js';
