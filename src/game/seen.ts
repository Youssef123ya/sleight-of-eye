// Seen test (G): is a world point inside any spectator's sight cone (measured from its CURRENT head forward)
// and not hidden by a cover prop? Cover follows the contract's meaning — "objects that block sight lines when
// they sit over something": a cup/box hides a point it stands over (ball under a cup, watch in the box), and
// does not hide a prop that merely sits in front of it on the mat.
import { Vector3, type Signal } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { Cafe, PropId, Settings, Spectator } from '../contracts.js';
import { DEG, angleBetween } from './math.js';

export interface SeenResult {
  by: Spectator;
  angleDeg: number;
}

export class SeenTester {
  private readonly eye = new Vector3();
  private readonly dir = new Vector3();
  private readonly to = new Vector3();
  private readonly c = new Vector3();
  private readonly ab = new Vector3();
  private readonly ac = new Vector3();

  constructor(
    private readonly cafe: Cafe,
    private readonly settings: Signal<Settings>,
  ) {}

  halfAngleDeg(): number {
    return this.settings.peek().easyAudience ? CFG.sightHalfAngleEasy : CFG.sightHalfAngle;
  }

  /**
   * The spectator (among `audience`) that sees `point`, preferring the most direct view; null when unseen.
   * `exclude` lists props that never count as cover (the prop being moved, the load target).
   */
  seen(
    point: Vector3,
    audience: readonly Spectator[],
    exclude: readonly PropId[] = [],
    blind?: (s: Spectator) => boolean,
  ): SeenResult | null {
    const half = this.halfAngleDeg() * DEG;
    let best: SeenResult | null = null;
    for (let i = 0; i < audience.length; i++) {
      const s = audience[i];
      let ang: number;
      try {
        if (!s.root.visible) continue;
        if (blind && blind(s)) continue; // e.g. Brock scribbling in his notebook sees nothing
        s.getEyeWorldPosition(this.eye);
        s.getLookDirection(this.dir);
      } catch {
        continue;
      }
      this.to.copy(point).sub(this.eye);
      ang = angleBetween(this.dir, this.to);
      if (ang > half) continue;
      if (this.covered(this.eye, point, exclude)) continue;
      if (!best || ang < best.angleDeg * DEG) best = { by: s, angleDeg: ang / DEG };
    }
    return best;
  }

  /** Cone-only test used for "watching the mat" (glyphs, tension); `marginDeg` widens the cone. */
  watching(s: Spectator, point: Vector3, marginDeg = 4): boolean {
    try {
      s.getEyeWorldPosition(this.eye);
      s.getLookDirection(this.dir);
    } catch {
      return false;
    }
    this.to.copy(point).sub(this.eye);
    return angleBetween(this.dir, this.to) <= (this.halfAngleDeg() + marginDeg) * DEG;
  }

  /** Degrees between a spectator's look direction and the direction to `point`. */
  angleTo(s: Spectator, point: Vector3): number {
    try {
      s.getEyeWorldPosition(this.eye);
      s.getLookDirection(this.dir);
    } catch {
      return 180;
    }
    this.to.copy(point).sub(this.eye);
    return angleBetween(this.dir, this.to) / DEG;
  }

  private covered(eye: Vector3, point: Vector3, exclude: readonly PropId[]): boolean {
    const props = this.cafe.props;
    for (const id in props) {
      const p = props[id as PropId];
      if (!p || !p.cover || exclude.indexOf(p.id) >= 0) continue;
      if (!p.root.visible) continue;
      p.root.getWorldPosition(this.c);
      const r = Math.max(0.015, p.radius || 0.03);
      this.c.y += r * 0.6; // centre of the cover body (props stand on their origin)
      // the cover must stand over the point …
      const dx = point.x - this.c.x;
      const dz = point.z - this.c.z;
      if (dx * dx + dz * dz > r * r * 1.3) continue;
      if (point.y > this.c.y + r) continue;
      // … and the eye→point segment must pass through its sphere
      if (this.segmentHitsSphere(eye, point, this.c, r)) return true;
    }
    return false;
  }

  private segmentHitsSphere(a: Vector3, b: Vector3, c: Vector3, r: number): boolean {
    this.ab.copy(b).sub(a);
    this.ac.copy(c).sub(a);
    const len2 = this.ab.lengthSq();
    let t = len2 > 1e-12 ? this.ac.dot(this.ab) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    this.ab.multiplyScalar(t).add(a); // closest point
    return this.ab.distanceToSquared(c) <= r * r;
  }
}
