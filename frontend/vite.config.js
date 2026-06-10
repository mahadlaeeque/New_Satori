import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the heavyweight vendors out of the main app chunk so login /
        // first paint only loads the app code; charts and icons arrive in
        // parallel cacheable chunks (html2canvas + jspdf are already lazy
        // dynamic imports). Keeps the main bundle well under the 500 kB warn.
        manualChunks: {
          recharts: ['recharts'],
          react: ['react', 'react-dom'],
          icons: ['lucide-react'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8001',
      '/ws': { target: 'ws://localhost:8001', ws: true },
    },
  },
})
