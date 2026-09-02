import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // 这些 Node 侧依赖（含插件内使用的 office 库）保持 external，运行时 require
              external: [
                'electron',
                'mammoth',
                'xlsx',
                'pdf-parse',
                'officeparser',
                'docx',
                'pptxgenjs',
              ],
            },
          },
        },
      },
      {
        entry: 'src/main/preload.ts',
        onstart: (options) => {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
