// Minimal landing page stub (G): title, tagline, Enter button and settings toggles, created in the DOM
// (index.html belongs to the UI module). Shown only while non-immersive.
import type { Signal } from '@iwsdk/core';
import type { Landing, Settings } from '../contracts.js';

let root: HTMLDivElement | null = null;

const TOGGLES: Array<[keyof Settings, string]> = [
  ['easyAudience', 'Easy Audience'],
  ['assist', 'Assist (eyes + one pinch)'],
  ['compactStage', 'Compact stage'],
  ['captions', 'Captions'],
  ['reducedMotion', 'Reduced motion'],
];

export const stubLanding: Landing = {
  mount(opts: { onEnter: () => void; settings: Signal<Settings>; xrSupported: boolean }) {
    if (root) return;
    root = document.createElement('div');
    root.id = 'landing-stub';
    root.style.cssText =
      'position:fixed;left:24px;bottom:24px;z-index:20;padding:18px 22px;max-width:340px;border-radius:14px;' +
      'background:rgba(20,16,30,0.82);color:#fff4dc;font:15px Georgia,serif;box-shadow:0 8px 30px rgba(0,0,0,0.4)';
    const h = document.createElement('div');
    h.textContent = 'Sleight of Eye';
    h.style.cssText = 'font:700 26px Georgia,serif;color:#ffcf5a;margin-bottom:4px';
    const p = document.createElement('div');
    p.textContent = 'They look where you look.';
    p.style.cssText = 'font-style:italic;margin-bottom:12px';
    const btn = document.createElement('button');
    btn.textContent = opts.xrSupported ? 'Enter' : 'Open on a Quest headset';
    btn.disabled = !opts.xrSupported;
    btn.style.cssText =
      'font:700 18px Georgia,serif;padding:10px 26px;border-radius:999px;border:2px solid #c99a3c;cursor:pointer;' +
      'background:#a8322d;color:#fff4dc;margin-bottom:12px';
    btn.addEventListener('click', () => opts.onEnter());
    root.append(h, p, btn);
    for (const [key, label] of TOGGLES) {
      const row = document.createElement('label');
      row.style.cssText = 'display:block;margin:3px 0;cursor:pointer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!opts.settings.peek()[key];
      cb.addEventListener('change', () => {
        opts.settings.value = { ...opts.settings.peek(), [key]: cb.checked };
      });
      opts.settings.subscribe((s) => {
        cb.checked = !!s[key];
      });
      row.append(cb, document.createTextNode(` ${label}`));
      root.append(row);
    }
    document.body.appendChild(root);
  },
  setVisible(visible: boolean) {
    if (root) root.style.display = visible ? 'block' : 'none';
  },
};
