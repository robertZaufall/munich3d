import { addressAssets } from './scripts/address-assets.mjs';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [
    // Shared CLI modules retain their executable shebang on disk. Strip it before
    // Vite prepends browser imports, which would otherwise make it invalid JS.
    { name: 'browser-cli-shebang', enforce: 'pre', transform(code, id) {
      if (id.endsWith('.mjs') && code.startsWith('#!')) return code.replace(/^#![^\n]*\n/u, '\n');
    } },
    react(), addressAssets(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    watch: isCodexSeatbeltSandbox
      ? { useFsEvents: false, usePolling: true }
      : undefined,
  },
  preview: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
  },
});
