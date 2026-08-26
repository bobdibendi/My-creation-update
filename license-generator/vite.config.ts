import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5174 pour ne pas entrer en conflit avec le dev server de My Creation (5173).

/**
 * La CSP stricte du index.html bloque le client Vite en développement
 * (scripts inline de react-refresh, WebSocket HMR ws://). En production elle
 * reste inchangée : ce plugin ne touche au HTML que quand Vite sert en dev.
 */
function relaxCspInDev(): Plugin {
  return {
    name: 'relax-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        '<!-- CSP désactivée en dev : le client Vite a besoin d\'inline scripts et de ws:// -->',
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), relaxCspInDev()],
  base: './',
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
