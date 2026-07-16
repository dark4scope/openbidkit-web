import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { existsSync, renameSync } from 'node:fs';

// Web 版构建：以 index.web.html 为入口（注入 window.yibiao 桥），产物落 dist/，
// 由 server/ 静态托管。收尾把 dist/index.web.html 重命名为 dist/index.html。
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [
    react(),
    {
      name: 'yibiao-web-html-rename',
      closeBundle() {
        const src = resolve(__dirname, 'dist/index.web.html');
        const dst = resolve(__dirname, 'dist/index.html');
        if (existsSync(src)) renameSync(src, dst);
      },
    },
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'index.web.html'),
    },
  },
});
