import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'drawpaper · 知识块连线笔记',
        short_name: 'drawpaper',
        description: '本地优先的无限画布知识块连线笔记工具',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,ttf,woff,woff2}'],
        // P1 接入大纲/标签/AI 面板后单 chunk 略超 2MiB 预缓存上限；提到 4MiB。
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // 函数式 manualChunks：把稳定重型依赖拆为独立可缓存 chunk，消除单 chunk >500KB 警告。
        // 顺序敏感：先匹配更具体的包，避免被兜底命中。
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-is)[\\/]/.test(id)) return 'react-vendor';
          if (/[\\/]node_modules[\\/]@xyflow[\\/]/.test(id)) return 'xyflow';
          if (/[\\/]node_modules[\\/](@tiptap|prosemirror-[a-z-]+)[\\/]/.test(id)) return 'tiptap';
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) return 'katex';
          // highlight.js 语法（lib/languages/*）随 highlight-data 动态 import，单独懒 chunk；
          // lowlight 核心 + highlight.js core 被 highlight.ts 静态引用，留在主包（小）。
          if (/[\\/]node_modules[\\/]highlight\.js[\\/]lib[\\/]languages[\\/]/.test(id)) return 'highlight';
          if (/[\\/]node_modules[\\/](@pdf-lib|pdf-lib|zlibjs|pako|rgb2hex)[\\/]/.test(id)) return 'pdf-lib';
          if (/[\\/]node_modules[\\/]html-to-image[\\/]/.test(id)) return 'html-to-image';
          if (/[\\/]node_modules[\\/]dexie[\\/]/.test(id)) return 'dexie';
          if (/[\\/]node_modules[\\/]minisearch[\\/]/.test(id)) return 'minisearch';
          if (/[\\/]node_modules[\\/]@drawpaper[\\/]core[\\/]/.test(id)) return 'drawpaper-core';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
