// One per-frame hook for every module and demo (owned by the lead). Runs in 2D and in XR via an ECS system.
// dt/time are seconds. A throwing callback is logged once and skipped instead of killing the frame loop.
import { createSystem, type World } from '@iwsdk/core';

type Tick = (dt: number, time: number) => void;

const ticks = new Set<Tick>();
const failed = new WeakSet<Tick>();

class UpdateLoopSystem extends createSystem({}) {
  update(delta: number, time: number) {
    const dt = Math.min(delta, 0.1); // clamp hitches so springs and tweens never explode
    for (const fn of ticks) {
      try {
        fn(dt, time);
      } catch (e) {
        if (!failed.has(fn)) {
          failed.add(fn);
          console.error('[loop] update callback threw (logged once):', e);
        }
      }
    }
  }
}

const registered = new WeakSet<World>();

/** Call `fn(dt, time)` every frame. Returns an unsubscribe function. */
export function onUpdate(world: World, fn: Tick): () => void {
  if (!registered.has(world)) {
    world.registerSystem(UpdateLoopSystem, { priority: 5 });
    registered.add(world);
  }
  ticks.add(fn);
  return () => ticks.delete(fn);
}
