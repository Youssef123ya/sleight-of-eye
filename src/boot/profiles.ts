// IWSDK loads hand/controller models from jsDelivr at runtime (a hard-coded constant in @iwsdk/xr-input).
// A CDN hiccup during judging would make the hands silently invisible, so serve them from public/profiles/
// (MIT, @webxr-input-profiles/assets 1.0.20 — see CREDITS.md). Installed before World.create.
const CDN = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles';

export function installProfileRedirect(): void {
  const local = `${import.meta.env.BASE_URL}profiles`;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(CDN)) return nativeFetch(local + url.slice(CDN.length), init);
    return nativeFetch(input, init);
  }) as typeof fetch;
}
