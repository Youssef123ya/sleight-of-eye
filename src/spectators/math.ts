// Small allocation-free math helpers for the felt audience (spectators module).
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** Wrap an angle to (-PI, PI]. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export function easeInOut(t: number): number {
  t = saturate(t);
  return t * t * (3 - 2 * t);
}
export function easeOutCubic(t: number): number {
  const u = 1 - saturate(t);
  return 1 - u * u * u;
}
export function easeInCubic(t: number): number {
  t = saturate(t);
  return t * t * t;
}
export function easeInQuad(t: number): number {
  t = saturate(t);
  return t * t;
}
/** Overshooting ease (anticipation's mirror image): ends at 1 after poking past it. */
export function easeOutBack(t: number, s = 1.7): number {
  t = saturate(t) - 1;
  return 1 + (s + 1) * t * t * t + s * t * t;
}
/** Normalised progress of t inside [a, b], clamped to 0..1. */
export function seg(t: number, a: number, b: number): number {
  return saturate((t - a) / (b - a));
}
/** Half-sine bump on [a, b] (0 outside). */
export function bump(t: number, a: number, b: number): number {
  if (t <= a || t >= b) return 0;
  return Math.sin((Math.PI * (t - a)) / (b - a));
}
/** Envelope: 0 → 1 over [a, a+fadeIn], holds, → 0 over [b-fadeOut, b]. Smooth at both ends. */
export function env(t: number, a: number, b: number, fadeIn: number, fadeOut: number): number {
  if (t <= a || t >= b) return 0;
  const i = fadeIn > 0 ? saturate((t - a) / fadeIn) : 1;
  const o = fadeOut > 0 ? saturate((b - t) / fadeOut) : 1;
  return easeInOut(Math.min(i, o));
}
/** Frame-rate independent exponential approach. */
export function damp(cur: number, target: number, rate: number, dt: number): number {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Deterministic PRNG (mulberry32): seeded puppets blink and fidget differently but reproducibly. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1-D damped spring (allocation-free). Semi-implicit Euler with small fixed substeps: stable at any frame rate. */
export class Spring {
  x = 0;
  v = 0;
  step(target: number, k: number, c: number, dt: number): number {
    if (!(dt > 0)) return this.x;
    const n = Math.min(10, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (k * (target - this.x) - c * this.v) * h;
      this.x += this.v * h;
    }
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) {
      this.x = Number.isFinite(target) ? target : 0;
      this.v = 0;
    }
    return this.x;
  }
  set(x: number): void {
    this.x = x;
    this.v = 0;
  }
}
