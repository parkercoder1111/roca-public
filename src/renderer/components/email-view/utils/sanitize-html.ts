import DOMPurify from 'dompurify'

// Force all links to open in system browser — Electron's will-navigate blocks same-window navigation
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function sanitizeHtmlBase(html: string): string {
  return String(DOMPurify.sanitize(html, { FORCE_BODY: true, FORBID_TAGS: ['link', 'base'], ADD_DATA_URI_TAGS: ['img'] }))
}

function postProcess(base: string, showImages?: boolean): string {
  // Strip layout-hijacking CSS — two passes handle both quote styles independently
  const noHijack = base
    // Scrub dangerous rules from <style> blocks while preserving layout rules
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, content) => {
      const safe = content
        .replace(/@import[^;]*;?/gi, '')
        .replace(/position\s*:\s*(fixed|sticky|absolute)\s*;?/gi, '')
        .replace(/z-index\s*:\s*[^;}]+[;]?/gi, '')
        .replace(/\bdisplay\s*:\s*none(?:\s*!important)?\s*;?/gi, '')
        .replace(/\bvisibility\s*:\s*hidden\s*;?/gi, '')
      return `<style${attrs}>${safe}</style>`
    })
    .replace(/(style\s*=\s*"[^"]*?)position\s*:\s*(fixed|sticky|absolute)\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*'[^']*?)position\s*:\s*(fixed|sticky|absolute)\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*"[^"]*?)z-index\s*:\s*[^;'"]+;?\s*/gi, '$1')
    .replace(/(style\s*=\s*'[^']*?)z-index\s*:\s*[^;'"]+;?\s*/gi, '$1')
    // Strip email pre-header hiders — callback strips ALL occurrences within a single style attribute
    .replace(/style\s*=\s*"([^"]*)"/gi, (_, val) => `style="${val.replace(/display\s*:\s*none(?:\s*!important)?\s*;?\s*/gi, '')}"`)
    .replace(/style\s*=\s*'([^']*)'/gi, (_, val) => `style='${val.replace(/display\s*:\s*none(?:\s*!important)?\s*;?\s*/gi, '')}'`)
    .replace(/style\s*=\s*(?!["'])([^\s>"']+(?:\s+!important)?)/gi, (_, val) => `style="${val.replace(/display\s*:\s*none(?:\s*!important)?\s*;?\s*/gi, '').replace(/visibility\s*:\s*hidden\s*;?\s*/gi, '').replace(/max-height\s*:\s*0\s*;?\s*/gi, '').replace(/opacity\s*:\s*0(?:\.0+)?\s*;?\s*/gi, '').replace(/font-size\s*:\s*(?:[0-2](?:\.[0-9]+)?|0?\.[0-9]+)px[^;]*;?\s*/gi, '').replace(/(?<![a-z-])color\s*:\s*(?:transparent|rgba\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\))\s*;?\s*/gi, '')}"`)

    .replace(/(style\s*=\s*"[^"]*?)visibility\s*:\s*hidden\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*'[^']*?)visibility\s*:\s*hidden\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*"[^"]*?)max-height\s*:\s*0\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*'[^']*?)max-height\s*:\s*0\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*"[^"]*?)opacity\s*:\s*0(?:\.0+)?\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*'[^']*?)opacity\s*:\s*0(?:\.0+)?\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*"[^"]*?)font-size\s*:\s*(?:[0-2](?:\.[0-9]+)?|0?\.[0-9]+)px[^;]*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*'[^']*?)font-size\s*:\s*(?:[0-2](?:\.[0-9]+)?|0?\.[0-9]+)px[^;]*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*"[^"]*?)(?<![a-z-])color\s*:\s*(?:transparent|rgba\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\))\s*;?\s*/gi, '$1')
    .replace(/(style\s*=\s*'[^']*?)(?<![a-z-])color\s*:\s*(?:transparent|rgba\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\))\s*;?\s*/gi, '$1')
    .replace(/\bbackground\s*=\s*(["'])((?:https?:)?\/\/[^"']*?)\1/gi, '')
    .replace(/\bbackground\s*=\s*((?:https?:)?\/\/[^\s>"']*)/gi, '')
  if (showImages) return noHijack
  return noHijack
    .replace(/<img(\b[^>]*?)\bsrc\s*=\s*(["'])(\/\/[^"']*?)\2/gi, '<img$1src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"')
    .replace(/<img(\b[^>]*?)\bsrc\s*=\s*(\/\/[^\s>"']*)/gi, '<img$1src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"')
    .replace(/<img(\b[^>]*?)\bsrc\s*=\s*(["'])(https?:\/\/[^"']*?)\2/gi, '<img$1src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"')
    .replace(/<img(\b[^>]*?)\bsrcset\s*=\s*(["'])[^"']*\2/gi, '<img$1')
    .replace(/<img(\b[^>]*?)\bsrc\s*=\s*(https?:\/\/[^\s>"']*)/gi, '<img$1src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"')
    .replace(/<source(\b[^>]*?)\bsrcset\s*=\s*(["'])[^"']*\2/gi, '<source$1')
    .replace(/<source(\b[^>]*?)\bsrc\s*=\s*(["'])(https?:\/\/[^"']*?)\2/gi, '<source$1src="data:,"')
    .replace(/<source(\b[^>]*?)\bsrc\s*=\s*(["'])(\/\/[^"']*?)\2/gi, '<source$1src="data:,"')
    .replace(/<source(\b[^>]*?)\bsrc\s*=\s*(https?:\/\/[^\s>"']*)/gi, '<source$1src="data:,"')
    .replace(/<source(\b[^>]*?)\bsrc\s*=\s*(\/\/[^\s>"']*)/gi, '<source$1src="data:,"')
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, content) =>
      `<style${attrs}>${content.replace(/url\(\s*['"]?(?:https?:)?\/\/[^)'"]*['"]?\s*\)/gi, 'url(data:,)')}</style>`
    )
    .replace(/(style\s*=\s*)(["'])([\s\S]*?)\2/gi, (_, prop, q, val) =>
      prop + q + val.replace(/&quot;/gi, "'").replace(/url\(\s*['"]?(?:https?:)?\/\/[^)'"]*['"]?\s*\)/gi, 'url(data:,)') + q
    )
}

export function sanitizeHtml(html: string, showImages?: boolean): string {
  return postProcess(sanitizeHtmlBase(html), showImages)
}

export function sanitizeHtmlPost(base: string, showImages?: boolean): string {
  return postProcess(base, showImages)
}
