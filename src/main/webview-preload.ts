// Preload script injected into every guest webview's renderer. Spoofs the
// JS-side Chrome identity (navigator.userAgentData) so sites that check the
// brand list via JS — most famously slack.com's signin page — accept ROCA as
// a real Chrome browser. The HTTP-header equivalents (Sec-CH-UA-*) are
// already rewritten in session-config.ts; this closes the in-page gap.

// Run in the page's JS context (the preload itself runs in an isolated
// world, so writing to `navigator` here only affects the preload world).
// Inject a small script tag into <head> as soon as the document exists so
// the override lands before any page JS sniffs `userAgentData`.
const injectIntoPage = (script: string) => {
  const tag = document.createElement('script')
  tag.textContent = script
  // Put it before any existing children so it executes first.
  const target = document.head || document.documentElement
  target.insertBefore(tag, target.firstChild)
  tag.remove()
}

// Major Chrome version pulled from the UA string the session already
// advertises — keeps the brand version in lockstep with the UA header.
const major = (navigator.userAgent.match(/Chrome\/(\d+)/)?.[1]) || '130'

// Report the platform that matches THIS webview's UA: macOS for ROCA's
// default Chrome identity, Chrome OS only for the Slack tab (whose UA is
// spoofed to CrOS to clear Slack's signin block). Deriving it from the UA —
// rather than hardcoding Chrome OS — keeps navigator.userAgentData consistent
// with the UA string, which bot checks like Cloudflare Turnstile require.
const isCrOS = /CrOS/.test(navigator.userAgent)
const platform = isCrOS ? 'Chrome OS' : 'macOS'
const platformVersion = isCrOS ? '14.0.0' : '15.0.0'

const script = `(() => {
  const major = ${JSON.stringify(major)};
  const platform = ${JSON.stringify(platform)};
  const platformVersion = ${JSON.stringify(platformVersion)};
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Not?A_Brand', version: '99' },
    { brand: 'Google Chrome', version: major },
  ];
  const fullVersionList = brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' }));
  const data = {
    brands,
    mobile: false,
    platform,
    getHighEntropyValues(hints) {
      const out = { brands, mobile: false, platform };
      if (!hints) return Promise.resolve(out);
      if (hints.includes('architecture')) out.architecture = 'arm';
      if (hints.includes('bitness')) out.bitness = '64';
      if (hints.includes('model')) out.model = '';
      if (hints.includes('platformVersion')) out.platformVersion = platformVersion;
      if (hints.includes('uaFullVersion')) out.uaFullVersion = major + '.0.0.0';
      if (hints.includes('fullVersionList')) out.fullVersionList = fullVersionList;
      if (hints.includes('wow64')) out.wow64 = false;
      return Promise.resolve(out);
    },
    toJSON() { return { brands, mobile: false, platform }; },
  };
  try {
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get() { return data; },
      configurable: true,
    });
  } catch {}
})();`

if (document.documentElement) {
  injectIntoPage(script)
} else {
  // Document not built yet — wait until the root element appears.
  const observer = new MutationObserver(() => {
    if (document.documentElement) {
      observer.disconnect()
      injectIntoPage(script)
    }
  })
  observer.observe(document, { childList: true, subtree: true })
}
