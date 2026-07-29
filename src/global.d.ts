/// <reference types="react" />

/**
 * Global type augmentations for Electron-specific DOM elements and CSS properties.
 */

// Extend React JSX to recognise the Electron <webview> element with its proper type.
// Without this, every webview attribute requires `as any` workarounds.
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<Electron.WebviewTag> & {
          src?: string
          allowpopups?: boolean
          preload?: string
          nodeintegration?: boolean
          partition?: string
          httpreferrer?: string
          useragent?: string
          disablewebsecurity?: boolean
        },
        Electron.WebviewTag
      >
    }
  }
}

// Extend CSSStyleDeclaration for vendor-prefixed properties used in mobile Safari.
interface CSSStyleDeclaration {
  /** iOS Safari vendor-prefixed overflow scrolling momentum */
  webkitOverflowScrolling: string
}

// ── Optical view: per-task claude stream-json child process ──
// The full electronAPI surface (including claudeStream) is declared in
// `src/renderer/app.tsx`. TypeScript cannot merge object-literal property
// types across two `interface Window` declarations, so the claudeStream
// sub-object is declared inline in app.tsx alongside the rest of the API.
