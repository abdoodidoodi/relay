import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()], clearScreen: false,
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/.relay-test/**', '**/artifacts/**', '**/_upstream/**'] }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: ['chrome105', 'safari14'], sourcemap: !!process.env.TAURI_DEBUG, modulePreload: { polyfill: false } }
});
