// Shared helpers for the gameplay-core IWER scenarios (tests/scenarios/core-*.mjs).
// Used through tests/shot.mjs --xr --scenario=...: `api.director(fn, arg)` runs `fn(d, arg)` in the page with
// the DemoDirector; `window.__app` is the game's DebugApi (+ where(name), events).

export const HEAD = [0, 1.2, 0];

export function makeHelpers(page, api) {
  const t0 = Date.now();
  const timeline = [];
  const failures = [];
  const note = (msg, extra) => {
    const entry = { t: ((Date.now() - t0) / 1000).toFixed(1), msg, ...(extra ? { extra } : {}) };
    timeline.push(entry);
    console.error(`[scenario ${entry.t}s] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  };
  const state = () => page.evaluate(() => window.__app?.debugState?.() ?? null);
  const events = () => page.evaluate(() => (window.__app?.events ?? []).map((e) => ({ ...e })));
  const where = (name) => page.evaluate((n) => window.__app?.where?.(n) ?? null, name);

  async function waitFor(pred, timeoutMs, label) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      last = await state();
      if (last && pred(last)) {
        note(`ok: ${label}`, { act: last.act, beat: last.beat, kind: last.beatKind, phase: last.phase });
        return last;
      }
      await page.waitForTimeout(80);
    }
    const msg = `timeout (${timeoutMs} ms) waiting for: ${label}`;
    failures.push(msg);
    note(msg, last ? { act: last.act, beat: last.beat, kind: last.beatKind, phase: last.phase, gaze: last.gazeTarget, hands: last.hands } : null);
    throw new Error(msg);
  }

  function check(cond, label, extra) {
    if (cond) note(`pass: ${label}`, extra);
    else {
      failures.push(label);
      note(`FAIL: ${label}`, extra);
    }
    return cond;
  }

  /** Teleport the head (eyes at HEAD) to look at a world point. */
  const look = (target) => api.director((d, t) => d.place({ head: t.head, look: t.look }), { head: HEAD, look: target });

  /** Smoothly turn the head to look at `target` over `duration` seconds. */
  const turnTo = (from, target, duration = 0.6) =>
    api.director(
      (d, a) => d.play({ duration: a.duration, head: { pos: [a.head, a.head], look: { points: [a.from, a.to], ease: 'minJerk' } } }),
      { head: HEAD, from, to: target, duration },
    );

  /** Bring the right hand to `pos` (grasp point), open, without moving the head. */
  const reach = (from, to, duration = 0.9, pinch = 0) =>
    api.director(
      (d, a) =>
        d.play({
          duration: a.duration,
          right: {
            anchor: 'grasp',
            fingers: 'forward',
            palm: 'down',
            pos: { points: [a.from, a.to], ease: 'minJerk' },
            pinch: [{ t: 0, v: a.pinch }, { t: a.duration, v: a.pinch }],
          },
        }),
      { from, to, duration, pinch },
    );

  /** Close (1) or open (0) the right-hand pinch at its current pin. */
  const pinch = (v, duration = 0.35) =>
    api.director(
      (d, a) => d.play({ duration: a.duration, right: { pinch: [{ t: 0, v: 1 - a.v }, { t: a.duration * 0.6, v: a.v }, { t: a.duration, v: a.v }] } }),
      { v, duration },
    );

  /** Index-finger poke: approach `target` from `from` in a pointing pose, then pull back. */
  const poke = (from, target, duration = 1.0) =>
    api.director(
      (d, a) =>
        d.play({
          duration: a.duration,
          right: {
            anchor: 'index-tip',
            fingers: 'forward',
            palm: 'down',
            poses: [{ t: 0, id: 'point' }],
            pos: { points: [a.from, a.target, a.target, a.from], ease: 'linear' },
            pinch: [{ t: 0, v: 0 }],
          },
        }),
      { from, target, duration },
    );

  /** Put the right hand somewhere harmless (resting below the table edge, open). */
  const rest = () => reach([0.2, 0.75, -0.1], [0.22, 0.78, -0.05], 0.4, 0);

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

  return { t0, timeline, failures, note, state, events, where, waitFor, check, look, turnTo, reach, pinch, poke, rest, add };
}
