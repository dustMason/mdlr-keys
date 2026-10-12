import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{find: /.*\/components\/Knob$/, replacement: fileURLToPath(new URL('./src/TouchKnob.tsx', import.meta.url))},{find: /.*\/components\/ModuleShell$/, replacement: fileURLToPath(new URL('./src/PanelShell.tsx', import.meta.url))}] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '../App/WebPanel', emptyOutDir: true, cssCodeSplit: false,
    lib: {entry: 'src/main.tsx',name:'MDLRPanel',formats:['iife'],fileName:()=> 'panel.js',cssFileName:'panel'},
    sourcemap: false,
  },
});
