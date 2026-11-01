// Gaze (G): head ray (or a real eye-gaze input source) → 1€ filter → focused target or a point on the
// tabletop / far backdrop, plus dwell timing and 'gaze:focus' / 'gaze:dwell' events. Allocation-free per frame.
import { Quaternion, Vector3, VisibilityState, type World } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { GameEvents, GazeState, GazeTarget, UI } from '../contracts.js';
import type { Emitter } from '../events.js';
import { L, type StageRig } from '../layout.js';
import { DEG, OneEuroVec3, RAD, angleBetween, angleTo, copyV, dist2, setV } from './math.js';
import type { GazeTargetRegistryImpl } from './registries.js';
import { rigFrame, worldPos, worldQuat, type RigFrame } from './space.js';

/** Targets farther than this from the gaze ray re-read their centre only every GAZE_REFRESH frames. */
const GAZE_NEAR_COS = Math.cos(25 * DEG);
const GAZE_REFRESH = 8;

interface TargetCache {
  readonly pos: Vector3;
  age: number;
}

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
  /** Raw (unfiltered) head position in world space: "the player's eyes" for spectators looking back. */
  readonly headPosition = new Vector3(0, 1.2, 0);
  /** Accumulated angular travel of the filtered gaze (degrees) since the last resetTravel(). */
  travel = 0;
  /** Set once the UI exists; the gaze drives its spotlight. */
  ui: UI | null = null;
  spotlightEnabled = true;

  private readonly filter = new OneEuroVec3(CFG.gazeMinCutoff, CFG.gazeBeta, 1.0, RAD);
  private readonly rawDir = new Vector3(0, 0, -1);
  private readonly prevDir = new Vector3(0, 0, -1);
  private readonly localO = new Vector3();
  private readonly localD = new Vector3();
  private readonly q = new Quaternion();
  private readonly playerQ = new Quaternion();
  private nextMark = 0;
  private focus: GazeTarget | null = null;
  private failedTargets = new WeakSet<GazeTarget>();
  private readonly frame: RigFrame;
  /** World positions of this frame's best candidate and of the kept focus (each target is sampled once). */
  private readonly bestPos = new Vector3();
  private readonly focusPos = new Vector3();
  private bestTarget: GazeTarget | null = null;
  private readonly cache = new WeakMap<GazeTarget, TargetCache>();
  /** Last spotlight handed to the UI (the UI converts every call to rig space: skip unchanged ones). */
  private readonly spotSent = new Vector3(Number.NaN, 0, 0);
  private spotOn = false;

  constructor(
    private readonly world: World,
    private readonly rig: StageRig,
    private readonly registry: GazeTargetRegistryImpl,
    private readonly events: Emitter<GameEvents>,
  ) {
    this.frame = rigFrame(rig);
  }

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
    const d = copyV(this.direction, this.rawDir);
    this.filter.filter(d, dt);
    let len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    if (len < 1e-4) {
      copyV(d, this.rawDir);
      len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
    }
    setV(d, d.x / len, d.y / len, d.z / len);
    this.travel += angleBetween(this.prevDir, d) * RAD;
    copyV(this.prevDir, d);

    const target = this.pickTarget();
    if (target) {
      copyV(this.point, target === this.focus && target !== this.bestTarget ? this.focusPos : this.bestPos);
      this.surface = 'target';
      this.frame.toLocal(this.point, this.pointLocal);
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

    // spotlight on the cloth (only when the point is on the tabletop); unchanged points are not re-sent
    if (this.ui) {
      const onCloth = this.spotlightEnabled && this.pointLocal.y < L.tableY + 0.04 && this.surface !== 'backdrop';
      if (onCloth !== this.spotOn || (onCloth && dist2(this.spotSent, this.point) > 1e-6)) {
        this.spotOn = onCloth;
        copyV(this.spotSent, this.point);
        try {
          this.ui.spotlight(onCloth ? this.point : null, 1);
        } catch {
          /* a UI failure must never break gaze */
        }
      }
    }
  }

  /** Head pose always; eye gaze when a 'gaze' input source (Meta VR Glasses, Quest Pro, IWER) reports a pose. */
  private sampleSource(): void {
    const world = this.world;
    const immersive = !!world.session && world.visibilityState.peek() !== VisibilityState.NonImmersive;
    // entity objects: their world matrices are current (IWSDK flushes the XR origin before the systems run)
    const head = immersive ? world.player.head : world.camera;
    worldPos(head, this.headPosition);
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
            worldQuat(world.player, this.playerQ);
            this.origin.set(p.x, p.y, p.z).applyMatrix4(world.player.matrixWorld);
            this.q.set(o.x, o.y, o.z, o.w).premultiply(this.playerQ);
            this.rawDir.set(0, 0, -1).applyQuaternion(this.q);
            this.source = 'eyes';
          }
          break;
        }
        if (this.source === 'head' && world.player.gazeOrigin === 'tracked') {
          worldPos(world.player.eyeSpace, this.origin);
          worldQuat(world.player.eyeSpace, this.q);
          this.rawDir.set(0, 0, -1).applyQuaternion(this.q);
          this.source = 'eyes';
        }
      }
    }
    if (this.source === 'head') {
      copyV(this.origin, this.headPosition);
      // forward = -Z column of the head's world matrix
      const e = head.matrixWorld.elements;
      const x = -e[8];
      const y = -e[9];
      const z = -e[10];
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len > 1e-9) setV(this.rawDir, x / len, y / len, z / len);
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
      let c = this.cache.get(t);
      if (!c) {
        c = { pos: new Vector3(), age: -1 }; // once per target
        this.cache.set(t, c);
      }
      try {
        if (!t.enabled()) {
          c.age = -1;
          continue;
        }
        if (c.age < 0 || c.age >= GAZE_REFRESH || this.nearRay(c.pos)) {
          t.getWorldPosition(c.pos);
          c.age = 0;
        } else c.age++;
      } catch (e) {
        this.failedTargets.add(t);
        console.warn(`[gaze] target "${t.id}" threw; ignoring it`, e);
        continue;
      }
      const px = c.pos.x;
      const py = c.pos.y;
      const pz = c.pos.z;
      if (px !== px) continue; // NaN: not placed yet
      const dx = px - this.origin.x;
      const dy = py - this.origin.y;
      const dz = pz - this.origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.04) continue;
      const ang = angleTo(this.direction, dx, dy, dz);
      const radius = Math.atan((t.radius || 0.01) / dist) + slack;
      if (t === this.focus && ang <= radius * 1.25) {
        currentAngle = ang;
        setV(this.focusPos, px, py, pz);
      }
      if (ang <= radius && ang < bestAngle) {
        bestAngle = ang;
        best = t;
        setV(this.bestPos, px, py, pz);
      }
    }
    this.bestTarget = best;
    // keep the current focus (stable dwell timers) unless another target is clearly closer to the ray
    if (this.focus && currentAngle < Infinity && (best === null || bestAngle > currentAngle - 1.5 * DEG)) {
      return this.focus;
    }
    return best;
  }

  /** Is a (cached) target centre within ~25° of the gaze ray? */
  private nearRay(p: Vector3): boolean {
    const dx = p.x - this.origin.x;
    const dy = p.y - this.origin.y;
    const dz = p.z - this.origin.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return true;
    const d = this.direction;
    return (dx * d.x + dy * d.y + dz * d.z) / len > GAZE_NEAR_COS;
  }

  /** Ray hit on the tabletop plane (rig-local y = L.tableY) or the far backdrop; writes point + pointLocal. */
  private castOnStage(): void {
    this.frame.toLocal(this.origin, this.localO);
    this.frame.dirToLocal(this.direction, this.localD);
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
        setV(this.pointLocal, x, L.tableY, z);
        this.surface = 'table';
        this.frame.toWorld(this.pointLocal, this.point);
        return;
      }
    }
    // far backdrop: the poster-wall plane, else a 2.5 m sphere
    let t = 2.5;
    if (d.z < -0.05) t = Math.min(4, (L.posterWall.z - o.z) / d.z);
    if (!(t > 0)) t = 2.5;
    setV(this.pointLocal, o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
    this.surface = 'backdrop';
    this.frame.toWorld(this.pointLocal, this.point);
  }
}
