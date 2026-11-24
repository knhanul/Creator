import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite discovers src/main/index.ts, src/preload/index.ts,
// and src/renderer/index.html using the official default conventions.
export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react()] }
});
