/**
 * MobileHostAdapter — REFERENCE implementation (not bundled into packages/web).
 *
 * This file lives under apps/mobile-capacitor/src/ and is **not** part of the
 * packages/web build. It documents how a future tablet-side HostAdapter would
 * map the core HostAdapter seam onto Capacitor plugins. When we actually ship
 * the Capacitor shell, copy/adapt this into packages/web/src/host/ alongside
 * web-host.ts and tauri-host.ts, and extend createBestHostAdapter() to detect
 * Capacitor runtime.
 *
 * Capacitor runtime detection: `window.Capacitor?.isNativePlatform()` returns
 * true inside the iOS/Android WebView; false in a plain browser PWA.
 *
 * Plugin choices (planning §12):
 *   - @capacitor/share      → share()
 *   - @capacitor/filesystem → open/save .kbnote to Documents/
 *   - @capacitor/app        → hardware back-button / resume events
 *
 * Privacy: same zero-network rule. Filesystem plugin only writes to app-private
 * directories unless the user explicitly picks a shared location.
 */

import type { HostAdapter, OpenFileResult } from '@drawpaper/core';

// These imports are intentionally commented out — this file is a reference only.
// When actually wiring, uncomment and add the plugins to packages/web deps.
// import { Share } from '@capacitor/share';
// import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
// import { App } from '@capacitor/app';

/** Detect Capacitor native runtime. */
function isCapacitorNative(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return Boolean(w?.Capacitor?.isNativePlatform?.());
}

/**
 * Tablet / mobile HostAdapter.
 *
 * Differences from WebHostAdapter:
 *  - No File System Access API on iPadOS/Android Chrome → open/save go through
 *    Filesystem plugin (app-private Documents dir). Users can still "export
 *    to Files / Share" via the share() path.
 *  - share() uses @capacitor/share (native sheet) instead of navigator.share.
 *  - print() on iOS/Android: no system print dialog from WebView without extra
 *    plugins; fall back to Web Share sheet so the user can "Print" from the
 *    share sheet.
 */
export class MobileHostAdapter implements HostAdapter {
  async showOpenFilePicker(): Promise<OpenFileResult | null> {
    // PWA on iPadOS already supports <input type=file> via the Files app; we
    // can reuse web-host.ts's openViaInput() path. The Filesystem plugin is
    // only needed for reading our own previously-exported drafts.
    //
    // Reference skeleton:
    //   const result = await Filesystem.readFile({
    //     path: 'drafts/untitled.kbnote',
    //     directory: Directory.Documents,
    //     encoding: Encoding.UTF8,
    //   });
    //   return { name: 'untitled.kbnote', text: String(result.data) };
    throw new Error('MobileHostAdapter.showOpenFilePicker: use PWA <input type=file> fallback');
  }

  async showSaveFilePicker(filename: string, text: string): Promise<void> {
    // Reference skeleton:
    //   const safe = filename.endsWith('.kbnote') ? filename : `${filename}.kbnote`;
    //   await Filesystem.writeFile({
    //     path: `exports/${safe}`,
    //     data: text,
    //     directory: Directory.Documents,
    //     encoding: Encoding.UTF8,
    //   });
    throw new Error('MobileHostAdapter.showSaveFilePicker: use download/share fallback');
  }

  print(): void {
    // Mobile WebView has no window.print() equivalent that opens a system
    // print dialog. The PWA export flow already produces a PDF blob; on
    // tablet we hand it to the share sheet so the user can pick "Print".
    // eslint-disable-next-line no-console
    console.warn('[mobile-host] print() deferred to share-sheet export');
  }

  async share(payload: { title: string; text?: string; file?: Blob }): Promise<void> {
    // Reference skeleton:
    //   await Share.share({
    //     title: payload.title,
    //     text: payload.text,
    //     // files: [fileUri] — requires writing Blob to cache first.
    //   });
    void payload;
  }
}

/**
 * Extended factory (when mobile shell ships):
 *
 *   export function createBestHostAdapter(): HostAdapter {
 *     if ('__TAURI__' in window) return new TauriHostAdapter();
 *     if (isCapacitorNative())   return new MobileHostAdapter();
 *     return new WebHostAdapter();
 *   }
 *
 * For now (P2 scaffold) we keep packages/web's createBestHostAdapter()
 * web/Tauri-only; MobileHostAdapter stays here as documentation.
 */
export { isCapacitorNative };
