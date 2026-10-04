import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for drawpaper tablet shell.
 *
 * Strategy (planning §4.12): PWA first — iPad/Android users install via browser
 * "Add to Home Screen". This Capacitor project is the fallback for app-store
 * distribution only. The web bundle is the same packages/web/dist used by PWA
 * and the Tauri desktop shell.
 */
const config: CapacitorConfig = {
  appId: 'com.drawpaper.app',
  appName: 'drawpaper',
  // webDir points at the built web bundle. Run `pnpm -r build` at repo root
  // before `cap sync`. If you prefer a copy (so the native project is
  // self-contained), run `pnpm copy:web` here and change webDir to './dist'.
  webDir: '../../packages/web/dist',
  backgroundColor: '#ffffff',
  android: {
    allowMixedContent: false,
    // drawpaper is local-first; no outbound network except optional user-configured
    // AI endpoint. We do NOT enable webDebug by default.
  },
  ios: {
    contentInset: 'always',
    // iPad multitasking / split view is desired.
    // CFBundleDisplayName etc. live in ios/App/Info.plist after `cap add ios`.
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#ffffff',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
