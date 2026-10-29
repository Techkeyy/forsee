import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ build: { rollupOptions: { input: { landing: resolve(process.cwd(), 'index.html'), app: resolve(process.cwd(), 'app.html') } } } });
