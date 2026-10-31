// capture/record.mjs - PIPELINE 1: headless Chrome + virtual time + WebCodecs -> 1080p60 MP4.
// Usage (dev server running, IWSDK_DEV_OPEN=false):
//   node capture/record.mjs [name] [--4k] [--realtime] [--url=http://127.0.0.1:8081/]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith('--')) ?? 'take';
const k4 = argv.includes('--4k');
const realtime = argv.includes('--realtime');
const url = (argv.find((a) => a.startsWith('--url=')) ?? '--url=http://127.0.0.1:8081/').slice(6);
const here = path.dirname(fileURLToPath(import.meta.url));
const captures = path.resolve(here, '../captures');
const [W, H] = k4 ? [3840, 2160] : [1920, 1080];

const browser = await chromium.launch({
  channel: 'chrome', // the installed Google Chrome (has H.264); no Playwright browser download
  headless: true,    // new headless; on this PC it renders on the RTX 3090 via ANGLE/D3D11
  args: ['--use-angle=d3d11', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
if (!realtime) await page.addInitScript({ path: path.join(here, 'virtual-time.js') });
await page.goto(url, { waitUntil: 'load' });

const result = await page.evaluate(
  ({ name, k4 }) => import('/capture/trailer.js').then((m) => m.run({ record: { name, bitrate: k4 ? 80e6 : 40e6 } })),
  { name, k4 },
);
await browser.close();
console.log(JSON.stringify(result, null, 2));

// Raw Annex-B H.264 has no timestamps and no colour tags (Chrome writes BT.709 limited-range YUV):
// declare the colours (setparams, no conversion), give every frame exactly 1/60 s, (down)scale, encode.
const src = path.join(captures, `${name}.h264`);
const out = path.join(captures, `${name}_1080p60.mp4`);
execFileSync('ffmpeg', [
  '-hide_banner', '-v', 'error', '-y', '-framerate', '60', '-i', src,
  '-vf', 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709,setpts=N/(60*TB)' +
    (k4 ? ',scale=1920:1080:flags=lanczos' : ''),
  '-r', '60', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-g', '60', '-movflags', '+faststart', out,
], { stdio: 'inherit' });
console.log('wrote', out);
