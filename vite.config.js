import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

// SharedArrayBuffer(ONNX Runtime のマルチスレッド)を有効にするためのヘッダ。
// 本番(nginx等)でも同じヘッダを付けること。README参照。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0') },
  base: '/',
  plugins: [
    ...(process.env.HTTPS === '1' ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'Transrate 会話翻訳',
        short_name: 'Transrate',
        description: 'オフラインで使える双方向の自動音声翻訳',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f1115',
        theme_color: '#0f1115',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,wasm,onnx,json,webmanifest}'],
        // ORT が参照だけしている未使用の wasm(asyncify/jsep 等)はプリキャッシュしない
        globIgnores: ['**/assets/ort-wasm-*'],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        navigateFallback: '/index.html',
        // モデル本体は transformers.js が Cache API(transformers-cache)に保存するため
        // Workbox 側では HuggingFace へのリクエストを一切扱わない。
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  server: {
    headers: isolationHeaders,
    // ローカル開発時のオンラインモード: `npm run dev:api` で起動した PHP へ中継
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
