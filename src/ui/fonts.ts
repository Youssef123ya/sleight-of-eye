// UI type: font stacks shared by the 2D landing page (CSS vars in index.html) and every canvas texture in XR.
// No font files ship yet: these are system stacks (Quest Browser resolves them to Noto Serif / Roboto). To
// self-host OFL fonts later, drop the files in public/fonts/ and list them in SELF_HOSTED below. The family
// names below already put "Playfair Display" / "Nunito" first, so canvases and CSS pick them up automatically.

/** Elegant display serif: titles, mastheads, posters, title cards. */
export const FONT_DISPLAY =
  '"Playfair Display", "Didot", "Bodoni 72", "Bodoni MT", "Palatino Linotype", Palatino, "Book Antiqua", "Noto Serif", Georgia, serif';
/** Friendly rounded sans: captions, plaque labels, small print. */
export const FONT_BODY =
  '"Nunito", "Avenir Next", Avenir, "Segoe UI", Roboto, "Trebuchet MS", "Helvetica Neue", Arial, sans-serif';

interface SelfHostedFont {
  family: string;
  /** File name inside public/fonts/. */
  file: string;
  descriptors?: FontFaceDescriptors;
}

/**
 * Self-hosted fonts, loaded with FontFace before any canvas text is drawn. Empty on purpose: list a file here
 * only once it exists, e.g. { family: 'Playfair Display', file: 'PlayfairDisplay[wght].ttf',
 * descriptors: { weight: '400 900' } } — a missing file would log a 404.
 */
const SELF_HOSTED: SelfHostedFont[] = [];

let ready: Promise<void> | null = null;

/** Resolve once every face used by canvas text is loaded (system fonts resolve immediately). Never rejects. */
export function ensureFonts(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return;
    try {
      for (const f of SELF_HOSTED) {
        const face = new FontFace(f.family, `url(${import.meta.env.BASE_URL}fonts/${encodeURI(f.file)})`, f.descriptors);
        document.fonts.add(await face.load());
      }
      await Promise.all([
        document.fonts.load(`700 64px ${FONT_DISPLAY}`),
        document.fonts.load(`italic 400 64px ${FONT_DISPLAY}`),
        document.fonts.load(`900 64px ${FONT_DISPLAY}`),
        document.fonts.load(`600 64px ${FONT_BODY}`),
        document.fonts.load(`800 64px ${FONT_BODY}`),
        document.fonts.load(`900 64px ${FONT_BODY}`),
        document.fonts.load(`italic 600 64px ${FONT_BODY}`),
      ]);
      await document.fonts.ready;
    } catch (e) {
      console.warn('[ui] font loading failed; using fallback faces', e);
    }
  })();
  return ready;
}
