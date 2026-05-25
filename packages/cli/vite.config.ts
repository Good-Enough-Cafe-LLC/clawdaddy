import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  root: 'web-cli',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './web-cli/src'),
      '@clawdaddy/core': path.resolve(__dirname, '../core/src/web.ts'),
    },
    mainFields: ['browser', 'module', 'main'],
  },
  build: {
    outDir: '../dist/web-ui',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,  // inline everything
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      }
    }
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
  },
})