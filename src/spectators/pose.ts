// A puppet pose is a flat Float32Array of additive channels (allocation-free blending of idle, mood and
// reaction layers). Angles in radians, distances in puppet units (metres before the instance scale).
export const PK = {
  // whole puppet (mover bone)
  x: 0,
  y: 1,
  z: 2,
  yaw: 3,
  lean: 4, // + = toward the player
  roll: 5,
  pivotZ: 6, // lean pivot (front of the feet when toppling)
  squash: 7, // + stretch, - squash (volume preserving)
  // head, additive on top of the look spring
  nod: 8, // + = chin down
  turn: 9,
  tilt: 10,
  override: 11, // 0..1 fades the look-at out (reaction owns the head)
  // face
  mouth: 12,
  lidClose: 13,
  lidLow: 14, // lower lids rise: happy "smiling" eyes
  lidTilt: 15, // + = angry brows (inner corners down)
  wide: 16,
  pupil: 17, // pupil dilation
  blush: 18,
  eyeAway: 19, // eyes slide down and aside (shy)
  dizzy: 20, // pupils spin
  // limbs
  armLSwing: 21, // + = forward
  armLRaise: 22, // + = outward
  armLTwist: 23,
  armRSwing: 24,
  armRRaise: 25,
  armRTwist: 26,
  aimL: 27, // 0..1 weight: point the arm along the aim vector
  aimR: 28,
  handL: 29,
  handR: 30,
  ears: 31, // + droop
  earPerk: 32,
  earL: 33,
  earR: 34,
  tailWag: 35,
  tailLift: 36,
  notebook: 37, // Brock raises the notebook
  scribble: 38, // Brock's pencil scribbles
  beak: 39, // magpie beak open
  lookTarget: 40, // look at the reaction's target instead of the lookAt target
  reach: 41, // paws slide out along the arm (stubby arms, big heads)
  COUNT: 42,
} as const;

export type Pose = Float32Array;

export function makePose(): Pose {
  return new Float32Array(PK.COUNT);
}

/** out += src * w (aim weights and the look override are clamped by the consumer). */
export function addPose(out: Pose, src: Pose, w: number): void {
  if (w <= 0) return;
  for (let i = 0; i < PK.COUNT; i++) out[i] += src[i] * w;
}
