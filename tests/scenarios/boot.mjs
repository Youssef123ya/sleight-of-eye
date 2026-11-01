// tests/scenarios/boot.mjs (owned by Q) — the game at / boots to a usable landing page (what a judge sees first).
//
//   node tests/scenarios/boot.mjs [--url=http://127.0.0.1:8081/] [--timeout=90]
//
// 2D, before any XR: the IWSDK world starts; window.__app (the game's DebugApi) appears; every service is the real
// module (window.__app.sources: a 'stub' means that module failed to load and the game silently fell back to its
// stand-in); the landing page is shown and its Enter button turns ready (landing mounted, isSessionSupported true
// under IWER); zero console errors during boot. Boot timings are reported (world, __app, Enter ready).
// Report: tests/out/scenarios/boot.json (+ boot-landing.png). Exit 0 = pass, 1 = a check failed, 2 = could not run.
import { pathToFileURL } from 'node:url';
import * as qa from '../lib/iwer.mjs';

/** Checks on a freshly opened page of the game (opened with tests/lib/iwer.mjs openApp). Never throws. */
export async function checkBoot(page, { t0 = Date.now(), shot = null } = {}) {
  const checks = [];
  const timings = { world: +((Date.now() - t0) / 1000).toFixed(2) };
  const check = (name, ok, detail = '') => (checks.push({ name, ok: !!ok, detail: String(detail ?? '') }), !!ok);
  let sources = null;
  let fatal = null;
  try {
    const has = await qa.hasApp(page, { timeout: 30_000 });
    timings.app = has ? +((Date.now() - t0) / 1000).toFixed(2) : null;
    check('window.__app (the game DebugApi) is installed', has, has ? `after ${timings.app} s` : 'no window.__app after 30 s');
    if (has) {
      sources = await qa.withTimeout(page.evaluate(() => window.__app?.sources ?? null), 5000, 'sources').catch(() => null);
      const stubs = sources ? Object.entries(sources).filter(([, v]) => v !== 'real').map(([k]) => k) : [];
      check(
        'every service is the real module (no stub fallback)',
        !!sources && stubs.length === 0,
        !sources ? 'window.__app.sources missing' : stubs.length ? `stub: ${stubs.join(', ')} (see the console warnings)` : Object.keys(sources).join(', '),
      );
    }
    const ready = await page
      .waitForFunction(() => {
        const b = document.getElementById('enter-btn');
        return !!b && !b.disabled;
      }, null, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    timings.enterReady = ready ? +((Date.now() - t0) / 1000).toFixed(2) : null;
    const landing = await qa
      .withTimeout(
        page.evaluate(() => {
          const el = document.getElementById('landing');
          const label = document.getElementById('enter-label')?.textContent?.trim() ?? document.getElementById('enter-btn')?.textContent?.trim() ?? null;
          if (!el) return { exists: false, label };
          const cs = getComputedStyle(el);
          return { exists: true, shown: !el.classList.contains('is-hidden') && cs.display !== 'none' && cs.visibility !== 'hidden', label };
        }),
        5000,
        'landing',
      )
      .catch(() => null);
    check('the landing page is shown', !!landing?.exists && landing.shown, landing ? (landing.exists ? `shown ${landing.shown}` : '#landing missing') : 'no answer');
    check("the landing's Enter button is ready", ready, `#enter-btn ${ready ? `enabled after ${timings.enterReady} s` : 'missing or still disabled after 20 s'}, label "${landing?.label ?? '?'}"`);
    if (shot) await qa.screenshot(page, shot).catch(() => {});
  } catch (e) {
    fatal = String(e?.stack ?? e);
  }
  const errors = [...qa.consoleErrors(page)];
  check('no console errors during boot', errors.length === 0, errors.slice(0, 3).join(' | '));
  const ok = !fatal && checks.every((c) => c.ok);
  return { ok, fatal, checks, sources, timings, errors, warnings: [...qa.consoleWarnings(page)].slice(0, 20) };
}

async function cli() {
  const args = qa.parseArgs();
  qa.installWatchdog(Number(args.timeout ?? 90) * 1000, 'boot');
  const url = qa.appUrl(qa.baseUrl(args), { demo: null });
  const shot = qa.outPath('scenarios', 'boot-landing.png');
  const t0 = Date.now();
  let res;
  let app = null;
  try {
    app = await qa.openApp(url, { w: 1280, h: 720 });
    res = await checkBoot(app.page, { t0, shot });
  } catch (e) {
    res = { ok: false, fatal: String(e?.message ?? e).split('\n')[0], checks: [], errors: e?.details?.errors ?? [] };
  } finally {
    await app?.close();
  }
  res.url = url;
  res.screenshot = res.fatal ? null : shot;
  qa.writeJson(qa.outPath('scenarios', 'boot.json'), res);
  console.log(
    JSON.stringify(
      { ok: res.ok, url, timings: res.timings, sources: res.sources, failures: (res.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), fatal: res.fatal ?? undefined },
      null,
      2,
    ),
  );
  process.exit(res.fatal && !res.checks?.length ? 2 : res.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();
