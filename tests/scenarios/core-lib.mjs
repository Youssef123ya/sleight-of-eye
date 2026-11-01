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

  /** window.__app.stage(): UI overlays on screen, curtain, visible cast (seated? rule target?), props, plaques. */
  const stage = () => page.evaluate(() => window.__app?.stage?.() ?? null);

  /** The game's tunables (src/config.ts, served by Vite), so waits follow CFG instead of hard-coded seconds. */
  const cfg = () => page.evaluate(async () => (await import('/src/config.ts')).CFG);

  /** Poke the Exit plaque. The session ends mid-poke, so the director's frame loop may never finish: not awaited. */
  const pokeExit = async () => {
    const p = await where('plaque-exit');
    if (!p) throw new Error('plaque-exit missing');
    poke(add(p, [0, 0.07, 0.07]), p, 0.9).catch(() => {});
  };

  /** Back into XR after an Exit: accept the re-offered session, seated eye looking at the mat. */
  const reenter = () =>
    page.evaluate(async (head) => {
      const { DemoDirector } = await import('/capture/director.js');
      const d = await DemoDirector.attach({ fovyDeg: 60 });
      window.__director = d;
      d.place({ head, look: [0, 0.9, -0.45] });
    }, HEAD);

  /**
   * The calm 2D attract view (before the first Enter, after every Exit): no show running, Act I's kits idling on
   * their seats, the coin alone on its mark, curtain open, every plaque back, and nothing left over from a beat.
   */
  async function checkAttract(label) {
    const s = await state();
    const st = await stage();
    check(!!s && s.attract && !s.started && !s.running && s.act === 0 && s.phase === 'idle', `${label}: attract view, no show running`, {
      attract: s?.attract,
      started: s?.started,
      act: s?.act,
      phase: s?.phase,
    });
    if (!st) {
      check(false, `${label}: window.__app.stage() available`);
      return { s, st };
    }
    const cast = st.spectators.filter((x) => x.id !== 'rabbit');
    check(JSON.stringify(cast.map((x) => x.id).sort()) === '["kit1","kit2","kit3"]', `${label}: Act I's three kits on stage`, {
      cast: cast.map((x) => x.id),
    });
    check(cast.every((x) => x.seated), `${label}: every kit is on its seat`, { cast });
    check(s.audienceIdle && cast.every((x) => x.target === null), `${label}: the audience idles and glances around (no rule drives them)`, {
      idle: s.audienceIdle,
      targets: cast.map((x) => x.target),
    });
    check(JSON.stringify(st.props) === JSON.stringify({ coin: 'home' }), `${label}: the coin alone, on its mark`, { props: st.props });
    check(st.curtainClosed !== true && !st.overlays.some((o) => /curtain/.test(o)), `${label}: curtain open`, {
      closed: st.curtainClosed,
      overlays: st.overlays,
    });
    const left = st.overlays.filter((o) => !/curtain/.test(o));
    check(left.length === 0, `${label}: no newspaper, captions, hints, banner, smear or spotlight`, { overlays: left });
    check(
      !s.reviewShown && s.hint === null && !s.musicBoxPlaying && s.palmed === null && !s.conesVisible && s.watchers === 0,
      `${label}: no review, hint, music box, palm, cones or watchers`,
      { review: s.reviewShown, hint: s.hint, musicBox: s.musicBoxPlaying, palmed: s.palmed, cones: s.conesVisible, watchers: s.watchers },
    );
    // the full set, not the bow's Retry + Exit (the real UI keeps Exit for XR only)
    check(['retry', 'easy', 'assist', 'recenter'].every((p) => st.plaques.includes(p)), `${label}: the full plaque set on the table edge`, {
      plaques: st.plaques,
    });
    return { s, st };
  }

  return {
    page, api, t0, timeline, failures, note, state, events, where, waitFor, check, look, turnTo, reach, pinch, poke, rest, add,
    stage, cfg, pokeExit, reenter, checkAttract,
  };
}
