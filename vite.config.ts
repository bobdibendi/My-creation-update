import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Electron loads the bundle from disk with file://, so assets must be relative.
  base: './',
  // Monaco worker chunks contain a dynamic import() in dead code paths;
  // the default iife worker format cannot carry it, so workers build as ESM.
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor', '@monaco-editor/react'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
})
