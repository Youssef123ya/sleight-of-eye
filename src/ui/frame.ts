// Rig-local ↔ world conversions for per-frame UI code. Allocation-free by construction: the arithmetic is inline
// and only objects cross call boundaries (StageRig.toLocal/toWorld go through three's shared vector helpers, and a
// helper that receives loose doubles boxes them whenever V8 does not inline it).
// The rig only moves on (re)calibration: sync() (a 16-number compare) picks that up.
import { Matrix4, type Object3D, type Vector3 } from '@iwsdk/core';
import type { StageRig } from '../layout.js';

export class UIFrame {
  private readonly inv = new Matrix4();
  private readonly seen = new Matrix4();

  constructor(private readonly rig: StageRig) {
    this.seen.elements[0] = Number.NaN; // force the first sync
    this.sync();
  }

  /** Refresh the inverse after a recalibration (cheap when nothing changed). */
  sync(): void {
    const m = this.rig.root.matrixWorld;
    if (this.seen.equals(m)) return;
    this.seen.copy(m);
    this.inv.copy(m).invert();
  }

  /** World point → rig-local point. */
  toLocal(p: Vector3, out: Vector3): Vector3 {
    const e = this.inv.elements;
    const x = p.x;
    const y = p.y;
    const z = p.z;
    out.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    out.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    out.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return out;
  }

  /**
   * Rig-local position of `obj`, from its world matrix as the renderer left it (≤ 1 frame stale for animated
   * nodes): never recomposes the IWSDK entity chain above it, unlike getWorldPosition().
   */
  objectLocal(obj: Object3D, out: Vector3): Vector3 {
    const w = obj.matrixWorld.elements;
    const x = w[12];
    const y = w[13];
    const z = w[14];
    const e = this.inv.elements;
    out.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    out.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    out.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return out;
  }

  /** Rig-local point → world point (reads the rig's current world matrix: always up to date). */
  toWorld(p: Vector3, out: Vector3): Vector3 {
    const e = this.rig.root.matrixWorld.elements;
    const x = p.x;
    const y = p.y;
    const z = p.z;
    out.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    out.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    out.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return out;
  }
}
