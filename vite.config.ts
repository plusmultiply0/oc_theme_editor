import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('src/renderer', import.meta.url)),
  plugins: [react()],
  base: './',
  build: {
    outDir: fileURLToPath(new URL('out/renderer', import.meta.url)),
    emptyOutDir: true,
  },
  // 开发期允许本机访问；生产构建由 Electron 加载本地文件，不加载远程页面（T11）
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('src/renderer', import.meta.url)),
    },
  },
  define: {
    __REPO_ROOT__: JSON.stringify(repoRoot),
  },
});
