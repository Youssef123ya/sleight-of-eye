// Seated stage layout (owned by the lead). All positions are RIG-LOCAL metres:
// origin = the player's calibrated eye position, +Y up, -Z forward (head yaw only, level).
// Angles in the comments are measured from the eye (pitch = vertical, yaw = horizontal).
import { Group, Quaternion, Vector3, type Object3D, type World } from '@iwsdk/core';

export type V3 = readonly [number, number, number];

const TABLE_Y = -0.3;

export const L = {
  tableY: TABLE_Y, // tabletop surface
  table: { centerZ: -0.55, width: 1.1, depth: 0.85 }, // spans z -0.125 .. -0.975
  mat: { center: [0, TABLE_Y + 0.003, -0.4] as V3, size: [0.36, 0.24] as const }, // ≈ -37° pitch
  propMarks: {
    coin: [0, TABLE_Y + 0.006, -0.4] as V3,
    ball: [0, TABLE_Y + 0.006, -0.38] as V3,
    cupLeft: [-0.095, TABLE_Y + 0.006, -0.42] as V3,
    cupMid: [0, TABLE_Y + 0.006, -0.42] as V3,
    cupRight: [0.095, TABLE_Y + 0.006, -0.42] as V3,
    watch: [0, TABLE_Y + 0.006, -0.39] as V3,
    // front-left of the mat: clear of the cup circles, easy to reach blind, inside the glasses frustum on any glance
    cupcake: [-0.06, TABLE_Y + 0.006, -0.335] as V3,
  },
  volunteerSpot: [0.1, TABLE_Y + 0.004, -0.33] as V3, // a kit hops here for the ear reveal
  riser: { z: -0.66, topY: TABLE_Y + 0.04, width: 0.5, depth: 0.12 },
  // 5 seats, feet on the riser; heads ≈ -13° pitch, yaw within ±15°
  seats: [
    [-0.18, TABLE_Y + 0.04, -0.66],
    [-0.09, TABLE_Y + 0.04, -0.66],
    [0, TABLE_Y + 0.04, -0.66],
    [0.09, TABLE_Y + 0.04, -0.66],
    [0.18, TABLE_Y + 0.04, -0.66],
  ] as V3[],
  shelf: { z: -0.84, topY: TABLE_Y + 0.2 },
  // Gadget bases (focus points sit a few cm above). ≈ ±20° yaw keeps every mat prop inside the Meta VR Glasses
  // frustum on a glance (tests/fov.mjs); a high shelf (≈ -4° pitch) keeps them ≈ 9° from the nearest spectator head.
  gadgets: {
    musicBox: [-0.3, TABLE_Y + 0.2, -0.84] as V3,
    firework: [0, TABLE_Y + 0.25, -0.92] as V3, // launcher stands taller so its fuse clears the heads (≈ -1°)
    candle: [0.3, TABLE_Y + 0.2, -0.84] as V3,
  },
  // Compact stage (limited neck movement): gadgets come in and up instead of out.
  gadgetsCompact: {
    musicBox: [-0.24, TABLE_Y + 0.28, -0.86] as V3,
    firework: [0, TABLE_Y + 0.31, -0.94] as V3,
    candle: [0.24, TABLE_Y + 0.28, -0.86] as V3,
  },
  burst: [0, 0.12, -0.95] as V3, // firework burst ≈ +7°
  plaques: [
    [-0.25, TABLE_Y + 0.012, -0.2],
    [-0.15, TABLE_Y + 0.012, -0.19],
    [0.15, TABLE_Y + 0.012, -0.19],
    [0.25, TABLE_Y + 0.012, -0.2],
  ] as V3[], // tilted ~35° toward the player
  lamp: [0, 0.42, -0.52] as V3,
  posterWall: { z: -1.6, centerX: -0.35, centerY: 0.12, width: 1.0, height: 0.9 }, // left of the window
  window: { center: [0.75, 0.25, -1.45] as V3, size: [0.8, 0.9] as const },
} as const;

/** Default eye pose used by demos and tests: seated eye height 1.2 m at the origin, facing -Z. */
export const DEFAULT_EYE: V3 = [0, 1.2, 0];

/**
 * The stage frame. Build gameplay objects as children of `root` using `L` coordinates.
 * `root` is level (yaw only) and sits at the calibrated eye position.
 */
export class StageRig {
  readonly root: Group;
  readonly eye = new Vector3();
  readonly forward = new Vector3(0, 0, -1);
  private calibrated = false;
  private readonly tmpQ = new Quaternion();
  private readonly tmpV = new Vector3();

  constructor(world: World) {
    this.root = new Group();
    this.root.name = 'StageRig';
    world.createTransformEntity(this.root, { persistent: true });
    this.calibrateAt(new Vector3(...DEFAULT_EYE), 0);
    this.calibrated = false;
  }

  get isCalibrated(): boolean {
    return this.calibrated;
  }

  /** Place the rig at an eye position with a heading (radians, 0 = facing -Z). */
  calibrateAt(eye: Vector3, yaw: number): void {
    this.eye.copy(eye);
    this.root.position.copy(eye);
    this.root.quaternion.setFromAxisAngle(this.tmpV.set(0, 1, 0), yaw);
    this.forward.set(0, 0, -1).applyQuaternion(this.root.quaternion);
    this.root.updateMatrixWorld(true);
    this.calibrated = true;
  }

  /** Calibrate from the current head (camera) world pose: keep yaw, drop pitch/roll. */
  calibrateFromHead(head: Object3D): void {
    head.updateMatrixWorld(true);
    const pos = head.getWorldPosition(new Vector3());
    head.getWorldQuaternion(this.tmpQ);
    const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(this.tmpQ);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.calibrateAt(pos, yaw);
  }

  /** Rig-local point → world point (writes into `out`). */
  toWorld(p: V3 | Vector3, out: Vector3): Vector3 {
    if (p instanceof Vector3) out.copy(p);
    else out.set(p[0], p[1], p[2]);
    return this.root.localToWorld(out);
  }

  /** World point → rig-local point (writes into `out`). */
  toLocal(p: Vector3, out: Vector3): Vector3 {
    return this.root.worldToLocal(out.copy(p));
  }
}
