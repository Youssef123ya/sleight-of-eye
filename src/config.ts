// Gameplay tunables in one place (owned by the lead). Times in seconds, distances in metres, angles in degrees.
export const CFG = {
  // Gaze
  gazeMinCutoff: 1.5, // 1€ filter
  gazeBeta: 0.05,
  gazeSlackDeg: 2.0, // extra angular radius when picking a gaze target
  gadgetDwell: 0.6, // look at a gadget this long to fire it
  eyeContactFox: 0.6, // a kit looks back at your face
  eyeContactCritic: 1.0, // Brock gets flustered

  // Audience
  followLag: 0.3, // kits follow the gaze point this far behind
  sightHalfAngle: 22, // a spectator "sees" a point inside this cone around its head forward
  sightHalfAngleEasy: 11,
  flusterDuration: 6.0, // Brock scribbles in his notebook
  bangLookDuration: 4.0, // every free head looks at the firework burst
  headTurnStiffness: 140, // spring for head turns (anticipation/overshoot live in the spectator module)
  headTurnDamping: 14,

  // Gadgets
  musicBoxDuration: 5.0,
  candleDuration: 5.0,
  fuseDuration: 2.5,

  // Hands
  pinchMagnet: 0.08, // grab a prop within this distance of the pinch point
  loadRadius: 0.1, // load a palmed prop within this distance of the target
  pokeRadiusMin: 0.035, // reveal/plaque poke spheres are at least this big
  pokeHysteresis: 0.012, // must leave radius + this before a new poke counts
  trackingGrace: 0.35, // tracking dropouts shorter than this are ignored

  // Flow
  hintDelay: 6.0, // inactivity before a ghost hint repeats
  catchCaptionTime: 1.6,
  rewindTime: 0.7,
  autosaveKey: 'sleight-of-eye.save.v1',
} as const;
