// JIT warm-up for the puppet code (event-time: once per kind, when the first puppet of that kind is created).
//
// V8 runs a function unoptimised — boxing every double it computes, i.e. allocating — until it has been called a few
// hundred times, reaches its top tier only after a few thousand calls, and falls back to the unoptimised tier the first
// time optimised code meets a branch it never saw (a first startle, fidget, bird saccade, scribble, hop...). Puppets
// update once per frame each, so left alone that took tens of seconds of show time and leaked ≈20 KB of garbage per
// frame meanwhile (measured with the sampling heap profiler and V8's deopt log). Instead, the first puppet of each kind
// drives a throwaway twin through every behaviour for a few thousand steps right away. The game builds its lineup
// while the act curtain is closed, the twin is never added to the scene, and the pass is time-capped.
import { Group, Vector3 } from '@iwsdk/core';
import type { ReactionName, Spectator, SpectatorKind } from '../contracts.js';
import { L, type V3 } from '../layout.js';

type Make = (kind: SpectatorKind, opts: { id: string; seed?: number; scale?: number }) => Spectator;

/** Diagnostics: kinds warmed, steps run and wall time spent (all kinds). */
export const warmStats = { kinds: [] as string[], steps: 0, ms: 0 };

const STEPS = 3600;
const BUDGET_MS = 90;
const warmed = new Set<SpectatorKind>();

const SCRIPT: Array<[ReactionName, number]> = [
  ['leanIn', 0],
  ['pointSqueak', 1], // 1 = with a target
  ['gasp', 0],
  ['clap', 0],
  ['topple', 0],
  ['giggle', 0],
  ['hopToVolunteer', 1],
  ['blushScribble', 0],
  ['hopBack', 0],
  ['cheer', 0],
  ['bow', 0],
  ['hopToVolunteer', 0], // default spot
  ['hopBack', 0],
  ['idle', 0],
];
const MOODS = ['neutral', 'eyeContact', 'suspicious', 'flustered'] as const;
const GLYPHS = ['open', 'closed', 'open', 'hidden'] as const;

/** Run the warm-up for `kind` once (no-op afterwards). `seed` keeps the twin on the real puppet's cached design. */
export function warmUpOnce(kind: SpectatorKind, make: Make, seed: number): void {
  if (warmed.has(kind)) return;
  warmed.add(kind);
  let twin: Spectator | null = null;
  const t0 = performance.now();
  let i = 0;
  try {
    const rig = new Group();
    rig.name = 'StageRig'; // the cone measures its height against this
    rig.position.set(0, 1.2, 0);
    twin = make(kind, { id: `__warmup-${kind}`, seed, scale: 1 });
    if (kind === 'rabbit') {
      rig.add(twin.root);
      twin.root.position.set(-0.235, L.tableY + 0.0005, -0.37);
      twin.root.rotation.set(0, 0.5, 0);
    } else {
      const p = L.seats[1];
      const seat = new Group();
      seat.position.set(p[0], p[1], p[2]);
      seat.rotation.y = Math.atan2(-p[0], -p[2]);
      rig.add(seat);
      seat.add(twin.root);
    }
    rig.updateMatrixWorld(true);
    const at = (p: V3) => new Vector3(p[0], p[1], p[2]).add(rig.position);
    const looks: Array<Vector3 | null> = [
      at([0, L.tableY + 0.006, -0.4]),
      at([L.gadgets.musicBox[0], L.gadgets.musicBox[1] + 0.07, L.gadgets.musicBox[2]]),
      at([0.1, L.tableY + 0.006, -0.33]),
      at([L.gadgets.candle[0], L.gadgets.candle[1] + 0.075, L.gadgets.candle[2]]),
      null,
      at([0, -0.02, -0.08]),
      at(L.burst),
      at([-0.25, L.tableY + 0.02, -0.25]),
    ];
    const volunteer = at(L.volunteerSpot);
    const urgent = { urgency: 1 };
    const calm = { urgency: 0.55 };
    const tmp = new Vector3();
    for (; i < STEPS; i++) {
      if ((i & 63) === 0 && performance.now() - t0 > BUDGET_MS) break;
      if (i % 37 === 0) twin.lookAt(looks[(i / 37) % looks.length], i % 259 === 0 ? urgent : calm);
      if (i % 53 === 0) twin.setMood(MOODS[(i / 53) % MOODS.length]);
      if (i % 31 === 0) twin.setEyeGlyph(GLYPHS[(i / 31) % GLYPHS.length]);
      if (i % 47 === 0) twin.setSightCone(i % 141 !== 0, i % 94 === 0);
      if (i % 61 === 0) {
        // most reactions are cut short by the next one; every third cycle lets them play out
        const k = Math.floor(i / 61);
        if (k % 3 !== 2) {
          const [name, withTarget] = SCRIPT[k % SCRIPT.length];
          const target = withTarget ? (name === 'pointSqueak' ? looks[0]! : volunteer) : undefined;
          void twin.react(name, { target, duration: name === 'blushScribble' ? 2 : undefined }).catch(() => {});
        }
      }
      if (i === 700) twin.setSightHalfAngle(11);
      if (i === 1400) twin.setSightHalfAngle(22);
      twin.setFrozen(i % 400 >= 390);
      twin.update(i % 97 === 0 ? 0.05 : i & 1 ? 1 / 72 : 1 / 90, 0);
      twin.getEyeWorldPosition(tmp);
      twin.getLookDirection(tmp);
    }
  } catch (e) {
    console.warn('[spectators] warm-up skipped', e);
  } finally {
    twin?.dispose();
    warmStats.kinds.push(kind);
    warmStats.steps += i;
    warmStats.ms += performance.now() - t0;
  }
}
