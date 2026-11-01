// Environment module entry: the midnight café set, props, gadgets and particle FX.
//
//   const { cafe, fx } = await environmentFactory.build(world, rig);
//   onUpdate(world, (dt, t) => { cafe.update(dt, t); fx.update(dt, t); });
//
// Notes for integrators:
// - Everything is parented under rig.root (rig-local L coordinates). Draw calls: ~20 static café + props/gadgets/FX.
// - cafe.update() also advances the gadgets and the FX; calling gadget.update()/fx.update() again in the same frame
//   is harmless (each guards on `time`).
// - Prop roots are named by PropId and start at their L.propMarks home; animations run on an inner pivot, so the
//   game may freely write prop.root's pose. The cupcake exposes a child 'cupcake-frosting'; watch.animate('rise')
//   moves the watch there by itself (and opens the box lid if it is closed).
// - Gadget focus objects are '<id>-focus'. Firework: the fuse always burns CFG.fuseDuration, then the rocket flies
//   to L.burst, bursts and calls onBurst; `duration` is the after-glow (glitter rain) that keeps eyes up
//   (default CFG.bangLookDuration, Infinity allowed). activate() is ignored while used/unavailable/active.
// - Plaque anchors ('plaqueAnchor-0..3') face the eye: +Z toward the player, +Y up the plaque face.
import type { EnvironmentFactory } from '../contracts.js';
import { CafeImpl } from './cafe.js';

export const environmentFactory: EnvironmentFactory = {
  async build(world, rig) {
    const cafe = new CafeImpl(world, rig);
    return { cafe, fx: cafe.fx };
  },
};
