// window.__app (G): the DebugApi used by tests and QA tooling, plus a few extras for scenario scripts:
// where(name) → world position of a named object, events → recent game events, sources → real/stub modules.
import { Quaternion, Vector3, type Object3D } from '@iwsdk/core';
import type { DebugApi, GameContext, GameEvents, PropId, Settings, Spectator } from '../contracts.js';
import type { Attention } from './attention.js';
import type { GazeTracker } from './gaze.js';
import type { HandTracker } from './hands.js';
import type { Hints } from './hints.js';
import { RAD } from './math.js';
import { PROP_IDS, type PropController } from './props.js';
import type { SessionController } from './session.js';
import { GADGET_IDS, type TrickRunner } from './tricks.js';

export interface DebugDeps {
  ctx: GameContext;
  runner: TrickRunner;
  session: SessionController;
  attention: Attention;
  gaze: GazeTracker;
  hands: HandTracker;
  props: PropController;
  hints: Hints;
  sources: Record<string, 'real' | 'stub'>;
}

export interface DebugExtras {
  where(name: string): [number, number, number] | null;
  events: Array<{ t: number; type: string; data: Record<string, unknown> }>;
  sources: Record<string, 'real' | 'stub'>;
  /** Recalibrate the stage to the current head (same as the Recenter plaque). */
  recenter(): void;
  /** A spectator object by id (QA probes). */
  spectator(id: string): Spectator | null;
}

const EVENT_TYPES: Array<keyof GameEvents> = [
  'gaze:focus',
  'pinch:start',
  'pinch:end',
  'poke',
  'prop:lifted',
  'prop:returned',
  'prop:palmed',
  'prop:loaded',
  'caught',
  'revealed',
  'gadget:activated',
  'gadget:ended',
  'beat:start',
  'beat:complete',
  'act:complete',
  'plaque',
  'session:visibility',
  'hands:trackingLost',
  'hands:trackingFound',
];

const r3 = (v: Vector3): [number, number, number] => [round(v.x), round(v.y), round(v.z)];
function round(n: number, k = 1000): number {
  return Math.round(n * k) / k;
}

export function installDebugApi(d: DebugDeps): DebugApi & DebugExtras {
  const { ctx, runner, session, attention, gaze, hands, props, hints } = d;
  const log: DebugExtras['events'] = [];
  const t0 = performance.now();
  for (const type of EVENT_TYPES) {
    ctx.events.on(type, (payload) => {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((payload ?? {}) as Record<string, unknown>)) {
        data[k] = v instanceof Vector3 ? r3(v) : v;
      }
      log.push({ t: round((performance.now() - t0) / 1000, 100), type, data });
      if (log.length > 120) log.splice(0, log.length - 120);
    });
  }

  const v = new Vector3();
  const head = new Vector3();
  const q = new Quaternion();

  const api: DebugApi & DebugExtras = {
    debugState() {
      const def = runner.def;
      const palmed = props.palmed();
      const loaded = props.loaded();
      const lifted = props.lifted();
      const s = ctx.settings.peek();
      const gadgets: Record<string, unknown> = {};
      for (const id of GADGET_IDS) {
        const g = ctx.cafe.gadgets[id];
        let active = false;
        try {
          active = !!g?.isActive();
        } catch {
          active = false;
        }
        gadgets[id] = { active, used: runner.gadgetUsed[id] };
      }
      const propModes: Record<string, string> = {};
      for (const id of PROP_IDS) if (props.has(id)) propModes[id] = props.mode(id);
      return {
        act: runner.act,
        beat: runner.beat,
        beatKind: def?.kind ?? null,
        beatName: def?.name ?? null,
        phase: runner.phase,
        beatTime: round(runner.beatTime, 100),
        started: runner.started,
        running: runner.running,
        caught: runner.caughtTotal,
        catchesThisAct: runner.catchesThisAct,
        lastCatch: runner.lastCatch,
        palmed: palmed ? palmed.id : null,
        palmedBy: palmed ? palmed.holder : null,
        // Record<PropId, PropId> (contracts DebugApi) while something is loaded, else null
        loaded: loaded ? { [loaded.id]: loaded.into } : null,
        lifted: lifted ? lifted.id : null,
        propModes,
        gazeTarget: gaze.targetId,
        gazeDwell: round(gaze.dwell, 100),
        gazeSurface: gaze.surface,
        gazeSource: gaze.source,
        gazePoint: r3(gaze.point),
        watchers: attention.watcherCount,
        alarm: attention.alarmId,
        bangActive: attention.bangUntil > attention.time,
        reviewShown: runner.reviewShown,
        conesVisible: attention.conesVisible,
        calibrated: session.calibrated,
        calibrations: session.calibrations,
        immersive: session.immersive,
        paused: session.paused,
        holdIt: session.holdIt,
        stars: runner.stars.slice(),
        quickReveal: runner.quickReveal,
        settings: { ...s },
        spectators: attention.watchers.map((w) => {
          let look: [number, number, number] | null = null;
          try {
            look = r3(w.spec.getLookDirection(v));
          } catch {
            look = null;
          }
          return {
            id: w.spec.id,
            rule: w.rule,
            watchingMat: w.watchingMat,
            eyeContact: w.eyeContact,
            flustered: attention.isFlustered(w.spec.id),
            look,
            /** where the attention rule points the head (world), and the eye it looks from */
            target: w.hasTarget ? r3(w.target) : null,
            eye: r3(w.eye),
          };
        }),
        gadgets,
        hands: {
          left: { tracked: hands.states.left.tracked, pinching: hands.states.left.pinching, pinch: r3(hands.states.left.pinchPoint) },
          right: {
            tracked: hands.states.right.tracked,
            pinching: hands.states.right.pinching,
            pinch: r3(hands.states.right.pinchPoint),
            index: r3(hands.states.right.indexTip),
          },
        },
        hint: hints.showing,
        revealTarget: runner.revealTargetId,
        assistRabbit: !!runner.rabbit?.root.visible,
      };
    },
    skipTo(act: number, beat?: number) {
      runner.skipTo(act, beat ?? 0);
      if (session.calibrated && session.immersive && !session.paused) runner.running = true;
    },
    setSettings(patch: Partial<Settings>) {
      session.setSettings(patch);
    },
    fovReport() {
      const out: Array<{ id: string; yaw: number; pitch: number; distance: number }> = [];
      const cam = session.immersive ? ctx.world.player.head : ctx.world.camera;
      cam.getWorldPosition(head);
      cam.getWorldQuaternion(q);
      q.invert();
      const add = (id: string, obj: Object3D | null | undefined, lift = 0) => {
        if (!obj) return;
        obj.getWorldPosition(v);
        v.y += lift;
        v.sub(head).applyQuaternion(q);
        const dz = -v.z;
        out.push({
          id,
          yaw: round(Math.atan2(v.x, dz) * RAD, 10),
          pitch: round(Math.atan2(v.y, dz) * RAD, 10),
          distance: round(v.length()),
        });
      };
      for (const id of PROP_IDS) {
        const p = ctx.cafe.props[id as PropId];
        if (p && p.root.visible) add(id, p.root, 0.01);
      }
      for (const id of GADGET_IDS) add(`${id}-focus`, ctx.cafe.gadgets[id]?.focus);
      for (const w of attention.watchers) {
        try {
          add(`${w.spec.id}-head`, w.spec.getAnchor('head'));
        } catch {
          add(w.spec.id, w.spec.root, 0.1);
        }
      }
      add('volunteerSpot', ctx.cafe.volunteerSpot);
      const scene = ctx.world.scene;
      for (const action of ['retry', 'easy', 'assist', 'recenter', 'exit']) {
        const o = scene.getObjectByName(`plaque-${action}`);
        if (o && o.visible) add(`plaque-${action}`, o);
      }
      const burst = new Vector3();
      ctx.rig.toWorld([0, 0.12, -0.95], burst);
      const marker = { getWorldPosition: (o: Vector3) => o.copy(burst) } as unknown as Object3D;
      add('burst', marker);
      return out;
    },
    where(name: string) {
      const o = ctx.world.scene.getObjectByName(name);
      if (!o) return null;
      o.getWorldPosition(v);
      return r3(v);
    },
    events: log,
    sources: d.sources,
    recenter() {
      session.calibrate();
    },
    spectator(id: string) {
      return runner.spectators.get(id) ?? null;
    },
  };
  window.__app = api;
  return api;
}
