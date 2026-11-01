// Gaze (G): head ray (or a real eye-gaze input source) → 1€ filter → focused target or a point on the
// tabletop / far backdrop, plus dwell timing and 'gaze:focus' / 'gaze:dwell' events. Allocation-free per frame.
import { Quaternion, Vector3, VisibilityState, type World } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { GameEvents, GazeState, GazeTarget, UI } from '../contracts.js';
import type { Emitter } from '../events.js';
import { L, type StageRig } from '../layout.js';
import { DEG, OneEuroVec3, RAD, angleBetween } from './math.js';
import type { GazeTargetRegistryImpl } from './registries.js';

/** Dwell thresholds that emit 'gaze:dwell' (sorted, unique). */
const DWELL_MARKS: number[] = [...new Set([CFG.gadgetDwell, CFG.eyeContactFox, CFG.eyeContactCritic])].sort(
  (a, b) => a - b,
);

export type GazeSurface = 'target' | 'table' | 'backdrop';

export class GazeTracker implements GazeState {
  readonly point = new Vector3(0, L.tableY, -0.4);
  readonly origin = new Vector3();
  readonly direction = new Vector3(0, 0, -1);
  targetId: string | null = null;
  dwell = 0;
  source: 'head' | 'eyes' = 'head';

  /** What the gaze point lies on. */
  surface: GazeSurface = 'table';
  /** Gaze point in rig-local coordinates. */
  readonly pointLocal = new Vector3(0, L.tableY, -0.4);
  /** Raw (unfiltered) head pose in world space: "the player's eyes" for spectators looking back. */
  readonly headPosition = new Vector3(0, 1.2, 0);
  readonly headQuaternion = new Quaternion();
  /** Accumulated angular travel of the filtered gaze (degrees) since the last resetTravel(). */
  travel = 0;
  /** Set once the UI exists; the gaze drives its spotlight. */
  ui: UI | null = null;
  spotlightEnabled = true;

  private readonly filter = new OneEuroVec3(CFG.gazeMinCutoff, CFG.gazeBeta, 1.0, RAD);
  private readonly rawDir = new Vector3(0, 0, -1);
  private readonly prevDir = new Vector3(0, 0, -1);
  private readonly tmp = new Vector3();
  private readonly localO = new Vector3();
  private readonly localD = new Vector3();
  private readonly q = new Quaternion();
  private readonly playerQ = new Quaternion();
  private readonly rigQInv = new Quaternion();
  private nextMark = 0;
  private focus: GazeTarget | null = null;
  private failedTargets = new WeakSet<GazeTarget>();

  constructor(
    private readonly world: World,
    private readonly rig: StageRig,
    private readonly registry: GazeTargetRegistryImpl,
    private readonly events: Emitter<GameEvents>,
  ) {}

  resetTravel(): void {
    this.travel = 0;
  }

  /** Forget filter state (after a recalibration or a session start). */
  resetFilter(): void {
    this.filter.reset();
  }

  update(dt: number): void {
    this.sampleSource();
    // filtered direction
    this.direction.copy(this.rawDir);
    this.filter.filter(this.direction, dt);
    if (this.direction.lengthSq() < 1e-8) this.direction.copy(this.rawDir);
    this.direction.normalize();
    this.travel += angleBetween(this.prevDir, this.direction) * RAD;
    this.prevDir.copy(this.direction);

    const target = this.pickTarget();
    if (target) {
      target.getWorldPosition(this.point);
      this.surface = 'target';
      this.rig.toLocal(this.point, this.pointLocal);
    } else {
      this.castOnStage();
    }

    // dwell + events
    const id = target ? target.id : null;
    if (id !== this.targetId) {
      this.targetId = id;
      this.focus = target;
      this.dwell = 0;
      this.nextMark = 0;
      this.events.emit('gaze:focus', { targetId: id });
    } else if (id !== null) {
      this.dwell += dt;
      while (this.nextMark < DWELL_MARKS.length && this.dwell >= DWELL_MARKS[this.nextMark]) {
        this.events.emit('gaze:dwell', { targetId: id, seconds: DWELL_MARKS[this.nextMark] });
        this.nextMark++;
      }
    }

    // spotlight on the cloth (only when the point is on the tabletop)
    if (this.ui) {
      const onCloth = this.spotlightEnabled && this.pointLocal.y < L.tableY + 0.04 && this.surface !== 'backdrop';
      try {
        this.ui.spotlight(onCloth ? this.point : null, 1);
      } catch {
        /* a UI failure must never break gaze */
      }
    }
  }

  /** Head pose always; eye gaze when a 'gaze' input source (Meta VR Glasses, Quest Pro, IWER) reports a pose. */
  private sampleSource(): void {
    const world = this.world;
    const immersive = !!world.session && world.visibilityState.peek() !== VisibilityState.NonImmersive;
    const head = immersive ? world.player.head : world.camera;
    head.getWorldPosition(this.headPosition);
    head.getWorldQuaternion(this.headQuaternion);
    this.source = 'head';

    if (immersive) {
      const frame = world.xrFrame;
      const ref = world.xrReferenceSpace;
      const session = world.session;
      if (frame && ref && session) {
        const sources = session.inputSources;
        for (let i = 0; i < sources.length; i++) {
          const s = sources[i];
          if (!s || s.targetRayMode !== 'gaze') continue;
          let pose: XRPose | undefined | null = null;
          try {
            pose = frame.getPose(s.targetRaySpace, ref);
          } catch {
            pose = null;
          }
          if (pose) {
            const p = pose.transform.position;
            const o = pose.transform.orientation;
            world.player.getWorldQuaternion(this.playerQ);
            this.origin.set(p.x, p.y, p.z).applyMatrix4(world.player.matrixWorld);
            this.q.set(o.x, o.y, o.z, o.w).premultiply(this.playerQ);
            this.rawDir.set(0, 0, -1).applyQuaternion(this.q);
            this.source = 'eyes';
          }
          break;
        }
        if (this.source === 'head' && world.player.gazeOrigin === 'tracked') {
          world.player.eyeSpace.getWorldPosition(this.origin);
          world.player.eyeSpace.getWorldQuaternion(this.q);
          this.rawDir.set(0, 0, -1).applyQuaternion(this.q);
          this.source = 'eyes';
        }
      }
    }
    if (this.source === 'head') {
      this.origin.copy(this.headPosition);
      this.rawDir.set(0, 0, -1).applyQuaternion(this.headQuaternion);
    }
  }

  /** Smallest angular distance inside (angular radius + slack); the current focus is kept with a little hysteresis. */
  private pickTarget(): GazeTarget | null {
    const list = this.registry.targets;
    let best: GazeTarget | null = null;
    let bestAngle = Infinity;
    let currentAngle = Infinity; // angle to the current focus when it is still (loosely) inside its radius
    const slack = CFG.gazeSlackDeg * DEG;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (this.failedTargets.has(t)) continue;
      try {
        if (!t.enabled()) continue;
        t.getWorldPosition(this.tmp);
      } catch (e) {
        this.failedTargets.add(t);
        console.warn(`[gaze] target "${t.id}" threw; ignoring it`, e);
        continue;
      }
      this.tmp.sub(this.origin);
      const dist = this.tmp.length();
      if (dist < 0.04) continue;
      const ang = angleBetween(this.direction, this.tmp);
      const radius = Math.atan((t.radius || 0.01) / dist) + slack;
      if (t === this.focus && ang <= radius * 1.25) currentAngle = ang;
      if (ang <= radius && ang < bestAngle) {
        bestAngle = ang;
        best = t;
      }
    }
    // keep the current focus (stable dwell timers) unless another target is clearly closer to the ray
    if (this.focus && currentAngle < Infinity && (best === null || bestAngle > currentAngle - 1.5 * DEG)) {
      return this.focus;
    }
    return best;
  }

  /** Ray hit on the tabletop plane (rig-local y = L.tableY) or the far backdrop; writes point + pointLocal. */
  private castOnStage(): void {
    this.rig.toLocal(this.origin, this.localO);
    this.rig.root.getWorldQuaternion(this.rigQInv).invert();
    this.localD.copy(this.direction).applyQuaternion(this.rigQInv);
    const o = this.localO;
    const d = this.localD;
    const halfW = L.table.width / 2 + 0.08;
    const zNear = L.table.centerZ + L.table.depth / 2 + 0.12;
    const zFar = L.table.centerZ - L.table.depth / 2 - 0.05;
    if (d.y < -0.02) {
      const t = (L.tableY - o.y) / d.y;
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      if (t > 0 && Math.abs(x) <= halfW && z <= zNear && z >= zFar) {
        this.pointLocal.set(x, L.tableY, z);
        this.surface = 'table';
        this.rig.toWorld(this.pointLocal, this.point);
        return;
      }
    }
    // far backdrop: the poster-wall plane, else a 2.5 m sphere
    let t = 2.5;
    if (d.z < -0.05) t = Math.min(4, (L.posterWall.z - o.z) / d.z);
    if (!(t > 0)) t = 2.5;
    this.pointLocal.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
    this.surface = 'backdrop';
    this.rig.toWorld(this.pointLocal, this.point);
  }
}
