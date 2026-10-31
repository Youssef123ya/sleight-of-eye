// capture/screen-record.mjs - PIPELINE 2: real Chrome window, fullscreen 1920x1080, recorded by ffmpeg.
// Usage (dev server running, primary monitor 1920x1080 @ 100 % scaling, don't touch the PC while it runs):
//   node capture/screen-record.mjs [name] [--dda] [--url=http://127.0.0.1:8081/]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith('--')) ?? 'screen-take';
const useDDA = argv.includes('--dda');
const url = (argv.find((a) => a.startsWith('--url=')) ?? '--url=http://127.0.0.1:8081/').slice(6);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../captures', `${name}.mp4`);

const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'iwsdk-capture-profile'), {
  channel: 'chrome',
  headless: false,
  chromiumSandbox: true,                                   // else Playwright adds --no-sandbox => infobar
  ignoreDefaultArgs: ['--enable-automation', 'about:blank'], // no "controlled by automated software" bar
  viewport: null,                                          // page size = real window size
  args: [
    `--app=${url}`, '--start-fullscreen', '--window-position=0,0', '--window-size=1920,1080',
    '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const page = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
await page.waitForLoadState('load');
await page.bringToFront();
const done = page.evaluate(() => import('/capture/trailer.js').then((m) => m.run({ preroll: 2 })));
await page.waitForFunction(() => window.__take?.state === 'rolling', null, { timeout: 60000 });

const grab = useDDA
  ? 'ddagrab=output_idx=0:framerate=60:draw_mouse=0'                                   // whole monitor
  : "gfxcapture=window_title='^IWSDK-CAPTURE$':capture_cursor=0:max_framerate=60";    // this window only
// Convert BGRA -> BT.709 limited YUV on the CPU before NVENC. Feeding BGRA straight into NVENC
// tags the stream matrix=GBR/full-range, which editors that assume BT.709 show with shifted colours.
const ff = spawn('ffmpeg', [
  '-hide_banner', '-y', '-filter_complex',
  `${grab},hwdownload,format=bgra,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
  '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '16', '-b:v', '0',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-fps_mode', 'cfr', '-r', '60', '-g', '60', '-movflags', '+faststart', out,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const result = await done;
ff.stdin.write('q'); // graceful stop: ffmpeg finalises the MP4
await new Promise((r) => ff.on('close', r));
await page.evaluate(() => window.IWER_DEVICE.activeSession?.end()).catch(() => {});
await ctx.close();
console.log(JSON.stringify(result.sequence), '\nwrote', out);
