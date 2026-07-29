import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: 'src/mobile',
  base: './',
  publicDir: false,
  build: {
    outDir: '../../dist/mobile',
    emptyOutDir: true,
    copyPublicDir: false,
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          content: ['./src/mobile/**/*.{html,tsx,ts}'],
          theme: {
            extend: {
              fontFamily: {
                sans: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
              },
            },
          },
        }),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5174,
  },
})
