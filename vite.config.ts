import {defineConfig} from 'vite'

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, not from the domain root,
  // so every asset URL has to be relative to this base. Vite rewrites the ones
  // in index.html; the ones fetched at runtime go through import.meta.env.BASE_URL
  // (see src/main.ts). Overridable so a fork can deploy elsewhere:
  //   BASE_PATH=/ npm run build
  base: process.env.BASE_PATH ?? '/wo-ist-die-bahn/',
  build: {target: 'es2022'}
})
