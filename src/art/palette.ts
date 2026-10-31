// "Midnight café, felt and brass" palette (owned by the lead). Hex sRGB.
export const PAL = {
  // night & room
  night: 0x0b1030,
  nightHorizon: 0x1c2452,
  windowGlow: 0x3a4f9a,
  wallDeep: 0x1a1426,
  wood: 0x6b4226,
  woodDark: 0x3e2615,
  // table
  lampAmber: 0xffb35c,
  lampWarm: 0xffd9a0,
  clothCream: 0xefe2c8,
  clothRed: 0xa8322d,
  velvet: 0x1f5a3a,
  velvetDeep: 0x123a25,
  chalk: 0xf4eedc,
  // metals & props
  brass: 0xc99a3c,
  gold: 0xffcf5a,
  copper: 0xc46a3a,
  ballRed: 0xd2372f,
  // puppets
  foxOrange: 0xe07a2e,
  foxCream: 0xf3e1c4,
  foxDark: 0x3a2a24,
  magpieBlack: 0x1c1d22,
  magpieWhite: 0xeeeef0,
  magpieTeal: 0x2aa3a0,
  badgerGrey: 0x8a8d93,
  badgerWhite: 0xf2f2f2,
  badgerBlack: 0x22232a,
  notebookRed: 0xb33a3a,
  rabbitWhite: 0xf6f3ee,
  hatBlack: 0x1a1a1f,
  blush: 0xff7f8e,
  // signals (never colour alone: always paired with a shape/icon)
  glintGold: 0xffd76a,
  glintBlue: 0x6fc8ff,
  target: 0x9dffb0,
  alarm: 0xff4a3d,
  text: 0xfff4dc,
  ink: 0x241a12,
} as const;

/** Spectator accent colours for sight cones / eye glyphs, by kind. */
export const SPECTATOR_ACCENT = {
  fox: PAL.foxOrange,
  magpie: PAL.magpieTeal,
  badger: PAL.gold,
  rabbit: PAL.rabbitWhite,
} as const;
