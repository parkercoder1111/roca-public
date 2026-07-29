import React, { useEffect, useRef } from 'react'
import type { WebviewToolSpec } from '../lib/webview-tools'
import { effectiveUserAgent } from '../lib/webview-tools'

interface Props {
  tool: WebviewToolSpec
  // Override the tool's default landing URL on first load — used for tabs
  // that were opened from an in-guest popup (e.g. Apps Script from Sheets).
  // Only applied to the initial src; later navigations within the webview
  // are not forced.
  initialUrl?: string
  // Forwarded ref to the underlying webview element. Lets the parent drive
  // navigation (loadURL/back/forward/reload) from the top-level URL bar.
  webviewRef?: React.MutableRefObject<Electron.WebviewTag | null>
  onUnreadChange?: (count: number) => void
  onFaviconChange?: (url: string) => void
  onTitleChange?: (title: string) => void
  // Browser-bar state — fired as the guest navigates so the URL bar reflects
  // the current page.
  onUrlChange?: (url: string) => void
  onLoadingChange?: (loading: boolean) => void
  onCanNavigateChange?: (canBack: boolean, canForward: boolean) => void
}

export function WebviewTool({
  tool, initialUrl, webviewRef,
  onUnreadChange, onFaviconChange, onTitleChange,
  onUrlChange, onLoadingChange, onCanNavigateChange,
}: Props) {
  const ref = useRef<Electron.WebviewTag | null>(null)
  // Stable refs so the effect doesn't re-run on every parent render.
  const onUnreadRef = useRef(onUnreadChange)
  onUnreadRef.current = onUnreadChange
  const onFaviconRef = useRef(onFaviconChange)
  onFaviconRef.current = onFaviconChange
  const onTitleRef = useRef(onTitleChange)
  onTitleRef.current = onTitleChange
  const onUrlRef = useRef(onUrlChange)
  onUrlRef.current = onUrlChange
  const onLoadingRef = useRef(onLoadingChange)
  onLoadingRef.current = onLoadingChange
  const onCanNavigateRef = useRef(onCanNavigateChange)
  onCanNavigateRef.current = onCanNavigateChange

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    // React serialises boolean attrs inconsistently on custom elements;
    // force `allowpopups` so Chromium reliably enables window.open() from
    // the guest page.
    wv.setAttribute('allowpopups', '')

    const emitTitle = () => {
      const title = wv.getTitle() || ''
      onTitleRef.current?.(title)
      if (!tool.parseUnreadFromTitle) return
      try {
        const count = tool.parseUnreadFromTitle(title)
        if (count != null) onUnreadRef.current?.(count)
      } catch { /* guest title formats drift — ignore parse errors */ }
    }
    const emitFavicon = (e: Event) => {
      const faviconEvent = e as unknown as { favicons?: string[] }
      const url = faviconEvent.favicons?.[0]
      if (url) onFaviconRef.current?.(url)
    }
    const emitNav = () => {
      try { onUrlRef.current?.(wv.getURL?.() || '') } catch {}
      try {
        const back = (wv as { canGoBack?: () => boolean }).canGoBack?.() ?? false
        const fwd = (wv as { canGoForward?: () => boolean }).canGoForward?.() ?? false
        onCanNavigateRef.current?.(back, fwd)
      } catch {}
    }
    const onDidNavigate = (e: Event) => {
      const ev = e as unknown as { url?: string }
      if (ev.url) onUrlRef.current?.(ev.url)
      emitNav()
    }
    const onStartLoading = () => onLoadingRef.current?.(true)
    const onStopLoading = () => { onLoadingRef.current?.(false); emitNav() }

    wv.addEventListener('page-title-updated', emitTitle)
    wv.addEventListener('did-finish-load', emitTitle)
    wv.addEventListener('did-finish-load', emitNav)
    wv.addEventListener('dom-ready', emitNav)
    wv.addEventListener('page-favicon-updated', emitFavicon)
    wv.addEventListener('did-navigate', onDidNavigate as EventListener)
    wv.addEventListener('did-navigate-in-page', onDidNavigate as EventListener)
    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    return () => {
      wv.removeEventListener('page-title-updated', emitTitle)
      wv.removeEventListener('did-finish-load', emitTitle)
      wv.removeEventListener('did-finish-load', emitNav)
      wv.removeEventListener('dom-ready', emitNav)
      wv.removeEventListener('page-favicon-updated', emitFavicon)
      wv.removeEventListener('did-navigate', onDidNavigate as EventListener)
      wv.removeEventListener('did-navigate-in-page', onDidNavigate as EventListener)
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
    }
  }, [tool])

  const setRef = (el: Electron.WebviewTag | null) => {
    ref.current = el
    if (webviewRef) webviewRef.current = el
  }

  return (
    <webview
      ref={setRef}
      src={initialUrl ?? tool.url}
      partition={tool.partition}
      allowpopups={true as unknown as boolean}
      useragent={effectiveUserAgent(tool)}
      style={{ width: '100%', height: '100%', display: 'inline-flex' }}
    />
  )
}
