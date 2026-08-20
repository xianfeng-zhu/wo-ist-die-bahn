### Task 1: Scaffold Vite app at repo root

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- Create: `src/main.ts` (minimal), `src/style.css` (minimal)
- Create: `.gitignore` (root — already exists from design work; verify contents)

**Step 1: Root package.json**

```json
{
  "name": "liveberlin",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "prepare:data": "node scripts/prepare-data.mjs"
  },
  "dependencies": {
    "leaflet": "^1.9.4"
  },
  "devDependencies": {
    "@types/leaflet": "^1.9.12",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

**Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

**Step 3: vite.config.ts**

```ts
import {defineConfig} from 'vite'

export default defineConfig({
  build: {target: 'es2022'}
})
```

**Step 4: index.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>liveberlin — live transit map</title>
</head>
<body>
  <div id="map"></div>
  <div id="statusbar"></div>
  <div id="filters"></div>
  <div id="attribution">Live data: VBB · Map: © OpenStreetMap contributors</div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 5: Minimal main.ts + style.css**

`src/main.ts`:
```ts
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'

const map = L.map('map').setView([52.52, 13.405], 12)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map)

export {map}
```

`src/style.css`:
```css
html, body, #map { height: 100%; margin: 0; }
body { font: 13px system-ui, sans-serif; }
```

**Step 6: Install + verify**

Run: `npm install`
Run: `npm run build`
Expected: `tsc` clean, `dist/` created with `index.html` + assets.
Run: `npm run dev` (background), open `http://localhost:5173` — Berlin map renders, no console errors. Stop dev server.

**Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold vite app"
```

---

