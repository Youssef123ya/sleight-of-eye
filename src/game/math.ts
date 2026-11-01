// Small allocation-free math helpers for the gameplay core (G).
import type { Vector3 } from '@iwsdk/core';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Frame-rate independent exponential approach (lambda ≈ 1/time-constant). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Angle in radians between two (not necessarily unit) vectors; 0 for degenerate input. */
export function angleBetween(a: Vector3, b: Vector3): number {
  return angleTo(a, b.x, b.y, b.z);
}

/**
 * Angle in radians between `a` and the vector (x, y, z); 0 for degenerate input. Plain arithmetic: per-frame code
 * calls this instead of three's Vector3 helpers, whose property loads IWSDK's synced transforms make megamorphic.
 */
export function angleTo(a: Vector3, x: number, y: number, z: number): number {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const la = Math.sqrt(ax * ax + ay * ay + az * az);
  const lb = Math.sqrt(x * x + y * y + z * z);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(clamp((ax * x + ay * y + az * z) / (la * lb), -1, 1));
}

// Per-frame vector writes. IWSDK's synced transforms make the property accesses inside three's shared Vector3
// helpers (set, copy, lerp, ...) megamorphic, and a megamorphic double load or store boxes the value. These tiny
// helpers only ever see plain Vector3s, so they stay monomorphic and allocation-free once optimised.
export function setV(out: Vector3, x: number, y: number, z: number): Vector3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyV(out: Vector3, v: Vector3): Vector3 {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  return out;
}

/** out = a + (b - a) * t */
export function lerpV(out: Vector3, a: Vector3, b: Vector3, t: number): Vector3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function dist2(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
}

export function easeInOutSine(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
}

/** Back-out easing with a little overshoot. */
export function easeOutBack(t: number, s = 1.6): number {
  const x = clamp01(t) - 1;
  return 1 + x * x * ((s + 1) * x + s);
}

/** Deterministic 0..1 hash of an integer (for staggers that must not use Math.random in tests). */
export function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 1€ filter for a 3-vector (Casiez et al. 2012). The speed term uses |dx/dt| converted to degrees per
 * second when the input is a unit direction, so CFG.gazeBeta (0.05) cuts lag on fast head turns while a
 * steady gaze is smoothed at CFG.gazeMinCutoff (1.5 Hz).
 */
export class OneEuroVec3 {
  private x = [0, 0, 0];
  private dx = [0, 0, 0];
  private ready = false;

  constructor(
    public minCutoff: number,
    public beta: number,
    public dCutoff = 1.0,
    /** Multiplier applied to the derivative magnitude before the beta term (RAD for unit directions). */
    public speedScale = 1,
  ) {}

  reset(): void {
    this.ready = false;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Filters `v` in place. */
  filter(v: Vector3, dt: number): Vector3 {
    if (!this.ready || !(dt > 0)) {
      this.x[0] = v.x;
      this.x[1] = v.y;
      this.x[2] = v.z;
      this.dx[0] = this.dx[1] = this.dx[2] = 0;
      this.ready = true;
      return v;
    }
    const ad = OneEuroVec3.alpha(this.dCutoff, dt);
    let speed2 = 0;
    for (let i = 0; i < 3; i++) {
      const raw = i === 0 ? v.x : i === 1 ? v.y : v.z;
      const d = (raw - this.x[i]) / dt;
      this.dx[i] = ad * d + (1 - ad) * this.dx[i];
      speed2 += this.dx[i] * this.dx[i];
    }
    const cutoff = this.minCutoff + this.beta * Math.sqrt(speed2) * this.speedScale;
    const a = OneEuroVec3.alpha(cutoff, dt);
    this.x[0] = a * v.x + (1 - a) * this.x[0];
    this.x[1] = a * v.y + (1 - a) * this.x[1];
    this.x[2] = a * v.z + (1 - a) * this.x[2];
    return setV(v, this.x[0], this.x[1], this.x[2]);
  }
}

/**
 * Fixed-capacity ring buffer of timestamped points (no allocation after construction). Used for the fox
 * kits' delayed follow of the gaze point.
 */
export class PointHistory {
  private readonly data: Float64Array;
  private head = 0;
  private count = 0;

  constructor(private readonly capacity = 128) {
    this.data = new Float64Array(capacity * 4);
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }

  push(t: number, p: Vector3): void {
    const o = this.head * 4;
    this.data[o] = t;
    this.data[o + 1] = p.x;
    this.data[o + 2] = p.y;
    this.data[o + 3] = p.z;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Writes the (interpolated) point at time `t` into `out`; returns false when empty. */
  sample(t: number, out: Vector3): boolean {
    if (this.count === 0) return false;
    // walk back from the newest sample
    let newer = -1;
    for (let k = 0; k < this.count; k++) {
      const idx = (this.head - 1 - k + this.capacity) % this.capacity;
      const ti = this.data[idx * 4];
      if (ti <= t) {
        if (newer < 0) {
          setV(out, this.data[idx * 4 + 1], this.data[idx * 4 + 2], this.data[idx * 4 + 3]);
          return true;
        }
        const tn = this.data[newer * 4];
        const f = tn > ti ? (t - ti) / (tn - ti) : 0;
        setV(
          out,
          this.data[idx * 4 + 1] + (this.data[newer * 4 + 1] - this.data[idx * 4 + 1]) * f,
          this.data[idx * 4 + 2] + (this.data[newer * 4 + 2] - this.data[idx * 4 + 2]) * f,
          this.data[idx * 4 + 3] + (this.data[newer * 4 + 3] - this.data[idx * 4 + 3]) * f,
        );
        return true;
      }
      newer = idx;
    }
    // older than everything we have: use the oldest
    const oldest = (this.head - this.count + this.capacity) % this.capacity;
    setV(out, this.data[oldest * 4 + 1], this.data[oldest * 4 + 2], this.data[oldest * 4 + 3]);
    return true;
  }
}
