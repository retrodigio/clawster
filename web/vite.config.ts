import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:18800',
      '/ws': { target: 'ws://localhost:18800', ws: true },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
