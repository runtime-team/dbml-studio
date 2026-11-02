import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiPort = process.env.PORT ?? '3001';
const docsPort = process.env.DBML_DOCS_PORT ?? '5174';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // These files are edited by the local API; Vite does not render them as modules.
    watch: { ignored: ['**/dbml.project.yaml', '**/diagram.yaml', '**/*.dbml'] },
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      '/docs': { target: `http://127.0.0.1:${docsPort}`, ws: true },
    },
  },
});
