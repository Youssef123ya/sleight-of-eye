// Allocation-free transform math for the felt puppets: plain numbers on Float64Arrays (column-major 4×4 like
// three's Matrix4.elements, quaternions as x, y, z, w). The formulas are three r185's own (Quaternion.setFromEuler,
// setFromAxisAngle, multiply, slerp, setFromUnitVectors, normalize; Matrix4.compose / multiplyMatrices / invert;
// Vector3.applyQuaternion / applyMatrix4), so poses come out the same as when the puppets used three's helpers.
//
// Why not call three per frame? IWSDK binds every ECS entity's position / quaternion / rotation / scale to typed-array
// storage through per-instance accessors, which leaves three's shared Euler / Quaternion / Matrix4 code megamorphic in
// this app. Measured in the running game: ≈85 B of garbage per `bone.rotation.set()`, ≈120 B per recomposed node in
// the renderer's scene-graph pass, ≈730 B per `getWorldPosition()` up a seat chain. Code here only ever sees
// Float64Arrays, so V8 keeps it monomorphic with unboxed doubles: nothing is allocated.

/** Column-major 4×4 identity. */
export function identity(m: Float64Array): void {
  m.fill(0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
}

/** Euler XYZ (three's default order) → quaternion at q[o..o+3]. */
export function quatEulerXYZ(q: Float64Array, o: number, x: number, y: number, z: number): void {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  q[o] = s1 * c2 * c3 + c1 * s2 * s3;
  q[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  q[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  q[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/** Euler YXZ (turn, then nod, then tilt: heads, eyes, the mover) → quaternion at q[o..o+3]. */
export function quatEulerYXZ(q: Float64Array, o: number, x: number, y: number, z: number): void {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  q[o] = s1 * c2 * c3 + c1 * s2 * s3;
  q[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  q[o + 2] = c1 * c2 * s3 - s1 * s2 * c3;
  q[o + 3] = c1 * c2 * c3 + s1 * s2 * s3;
}

/** Rotation of `angle` about the unit axis (ax, ay, az) → quaternion at q[o..o+3]. */
export function quatAxisAngle(q: Float64Array, o: number, ax: number, ay: number, az: number, angle: number): void {
  const half = angle / 2;
  const s = Math.sin(half);
  q[o] = ax * s;
  q[o + 1] = ay * s;
  q[o + 2] = az * s;
  q[o + 3] = Math.cos(half);
}

/** q = q · b (three's Quaternion.multiply). */
export function quatMul(q: Float64Array, o: number, bx: number, by: number, bz: number, bw: number): void {
  const ax = q[o];
  const ay = q[o + 1];
  const az = q[o + 2];
  const aw = q[o + 3];
  q[o] = ax * bw + aw * bx + ay * bz - az * by;
  q[o + 1] = ay * bw + aw * by + az * bx - ax * bz;
  q[o + 2] = az * bw + aw * bz + ax * by - ay * bx;
  q[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

export function quatNormalize(q: Float64Array, o: number): void {
  let l = Math.sqrt(q[o] * q[o] + q[o + 1] * q[o + 1] + q[o + 2] * q[o + 2] + q[o + 3] * q[o + 3]);
  if (l === 0) {
    q[o] = 0;
    q[o + 1] = 0;
    q[o + 2] = 0;
    q[o + 3] = 1;
  } else {
    l = 1 / l;
    q[o] = q[o] * l;
    q[o + 1] = q[o + 1] * l;
    q[o + 2] = q[o + 2] * l;
    q[o + 3] = q[o + 3] * l;
  }
}

/** Spherical interpolation of q[o..o+3] toward b by t (three r185 Quaternion.slerp). */
export function quatSlerp(q: Float64Array, o: number, bx: number, by: number, bz: number, bw: number, t: number): void {
  let x = bx;
  let y = by;
  let z = bz;
  let w = bw;
  let dot = q[o] * bx + q[o + 1] * by + q[o + 2] * bz + q[o + 3] * bw;
  if (dot < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
    dot = -dot;
  }
  let s = 1 - t;
  if (dot < 0.9995) {
    const theta = Math.acos(dot);
    const sin = Math.sin(theta);
    s = Math.sin(s * theta) / sin;
    t = Math.sin(t * theta) / sin;
    q[o] = q[o] * s + x * t;
    q[o + 1] = q[o + 1] * s + y * t;
    q[o + 2] = q[o + 2] * s + z * t;
    q[o + 3] = q[o + 3] * s + w * t;
  } else {
    // small angles: lerp, then normalise
    q[o] = q[o] * s + x * t;
    q[o + 1] = q[o + 1] * s + y * t;
    q[o + 2] = q[o + 2] * s + z * t;
    q[o + 3] = q[o + 3] * s + w * t;
    quatNormalize(q, o);
  }
}

/** Shortest rotation taking unit vector f onto unit vector t → q[o..o+3] (three's setFromUnitVectors). */
export function quatFromUnitVectors(
  q: Float64Array,
  o: number,
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
): void {
  let r = fx * tx + fy * ty + fz * tz + 1;
  if (r < 1e-8) {
    // opposite directions: any perpendicular axis
    r = 0;
    if (Math.abs(fx) > Math.abs(fz)) {
      q[o] = -fy;
      q[o + 1] = fx;
      q[o + 2] = 0;
      q[o + 3] = r;
    } else {
      q[o] = 0;
      q[o + 1] = -fz;
      q[o + 2] = fy;
      q[o + 3] = r;
    }
  } else {
    q[o] = fy * tz - fz * ty;
    q[o + 1] = fz * tx - fx * tz;
    q[o + 2] = fx * ty - fy * tx;
    q[o + 3] = r;
  }
  quatNormalize(q, o);
}

/** out = v rotated by the unit quaternion q[o..o+3] (three's Vector3.applyQuaternion). */
export function rotateByQuat(q: Float64Array, o: number, vx: number, vy: number, vz: number, out: Float64Array): void {
  const qx = q[o];
  const qy = q[o + 1];
  const qz = q[o + 2];
  const qw = q[o + 3];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
}

/**
 * m[mo..mo+15] = compose(position, quaternion, scale) of slot `i` of the TRS arrays (tp/ts: 3 per slot, tq: 4 per
 * slot) — three's Matrix4.compose.
 */
export function composeAt(m: Float64Array, mo: number, tp: Float64Array, tq: Float64Array, ts: Float64Array, i: number): void {
  const qo = i * 4;
  const vo = i * 3;
  const x = tq[qo];
  const y = tq[qo + 1];
  const z = tq[qo + 2];
  const w = tq[qo + 3];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = ts[vo];
  const sy = ts[vo + 1];
  const sz = ts[vo + 2];
  m[mo] = (1 - (yy + zz)) * sx;
  m[mo + 1] = (xy + wz) * sx;
  m[mo + 2] = (xz - wy) * sx;
  m[mo + 3] = 0;
  m[mo + 4] = (xy - wz) * sy;
  m[mo + 5] = (1 - (xx + zz)) * sy;
  m[mo + 6] = (yz + wx) * sy;
  m[mo + 7] = 0;
  m[mo + 8] = (xz + wy) * sz;
  m[mo + 9] = (yz - wx) * sz;
  m[mo + 10] = (1 - (xx + yy)) * sz;
  m[mo + 11] = 0;
  m[mo + 12] = tp[vo];
  m[mo + 13] = tp[vo + 1];
  m[mo + 14] = tp[vo + 2];
  m[mo + 15] = 1;
}

/** out = a · b[bo..bo+15] for affine matrices (bottom row 0 0 0 1). `out` must not alias `a` or `b`. */
export function mulAffine(a: Float64Array, b: Float64Array, bo: number, out: Float64Array): void {
  const a11 = a[0];
  const a12 = a[4];
  const a13 = a[8];
  const a14 = a[12];
  const a21 = a[1];
  const a22 = a[5];
  const a23 = a[9];
  const a24 = a[13];
  const a31 = a[2];
  const a32 = a[6];
  const a33 = a[10];
  const a34 = a[14];
  const b11 = b[bo];
  const b12 = b[bo + 4];
  const b13 = b[bo + 8];
  const b14 = b[bo + 12];
  const b21 = b[bo + 1];
  const b22 = b[bo + 5];
  const b23 = b[bo + 9];
  const b24 = b[bo + 13];
  const b31 = b[bo + 2];
  const b32 = b[bo + 6];
  const b33 = b[bo + 10];
  const b34 = b[bo + 14];
  out[0] = a11 * b11 + a12 * b21 + a13 * b31;
  out[4] = a11 * b12 + a12 * b22 + a13 * b32;
  out[8] = a11 * b13 + a12 * b23 + a13 * b33;
  out[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14;
  out[1] = a21 * b11 + a22 * b21 + a23 * b31;
  out[5] = a21 * b12 + a22 * b22 + a23 * b32;
  out[9] = a21 * b13 + a22 * b23 + a23 * b33;
  out[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24;
  out[2] = a31 * b11 + a32 * b21 + a33 * b31;
  out[6] = a31 * b12 + a32 * b22 + a33 * b32;
  out[10] = a31 * b13 + a32 * b23 + a33 * b33;
  out[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34;
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[15] = 1;
}

/** out = m⁻¹ for an affine matrix (identity if singular). `out` must not alias `m`. */
export function invertAffine(m: Float64Array, out: Float64Array): void {
  const r00 = m[0];
  const r10 = m[1];
  const r20 = m[2];
  const r01 = m[4];
  const r11 = m[5];
  const r21 = m[6];
  const r02 = m[8];
  const r12 = m[9];
  const r22 = m[10];
  const c00 = r11 * r22 - r12 * r21;
  const c01 = r12 * r20 - r10 * r22;
  const c02 = r10 * r21 - r11 * r20;
  const det = r00 * c00 + r01 * c01 + r02 * c02;
  if (det === 0 || !Number.isFinite(det)) {
    identity(out);
    return;
  }
  const k = 1 / det;
  const i00 = c00 * k;
  const i10 = c01 * k;
  const i20 = c02 * k;
  const i01 = (r02 * r21 - r01 * r22) * k;
  const i11 = (r00 * r22 - r02 * r20) * k;
  const i21 = (r01 * r20 - r00 * r21) * k;
  const i02 = (r01 * r12 - r02 * r11) * k;
  const i12 = (r02 * r10 - r00 * r12) * k;
  const i22 = (r00 * r11 - r01 * r10) * k;
  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  out[0] = i00;
  out[1] = i10;
  out[2] = i20;
  out[3] = 0;
  out[4] = i01;
  out[5] = i11;
  out[6] = i21;
  out[7] = 0;
  out[8] = i02;
  out[9] = i12;
  out[10] = i22;
  out[11] = 0;
  out[12] = -(i00 * tx + i01 * ty + i02 * tz);
  out[13] = -(i10 * tx + i11 * ty + i12 * tz);
  out[14] = -(i20 * tx + i21 * ty + i22 * tz);
  out[15] = 1;
}

/** out = m · (x, y, z, 1) for an affine matrix. Inputs are read before `out` is written (out may be an input's source). */
export function xformPoint(m: Float64Array, x: number, y: number, z: number, out: Float64Array): void {
  const ox = m[0] * x + m[4] * y + m[8] * z + m[12];
  const oy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const oz = m[2] * x + m[6] * y + m[10] * z + m[14];
  out[0] = ox;
  out[1] = oy;
  out[2] = oz;
}

/**
 * A copy of some Object3D's matrixWorld plus its inverse, refreshed only when the source changed (16 compares).
 * Starts as identity, like an Object3D that has never been rendered.
 */
export class FrameCache {
  readonly m = new Float64Array(16);
  readonly inv = new Float64Array(16);

  constructor() {
    identity(this.m);
    identity(this.inv);
  }

  /** Pick up `e` (a Matrix4.elements as the renderer left it); recompute the inverse only when it changed. */
  sync(e: ArrayLike<number>): void {
    const m = this.m;
    let same = true;
    for (let i = 0; i < 16; i++) {
      if (m[i] !== e[i]) {
        same = false;
        break;
      }
    }
    if (same) return;
    for (let i = 0; i < 16; i++) m[i] = e[i];
    invertAffine(m, this.inv);
  }
}
