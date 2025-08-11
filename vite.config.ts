import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import fs from "fs";
import fsp from "fs/promises";

function imagesManifestPlugin(): Plugin {
  const supported = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
  const imagesDir = path.resolve(__dirname, "public", "images");
  const manifestPath = path.resolve(imagesDir, "manifest.json");

  async function ensureDir(dir: string) {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {}
  }

  async function scanDir(currentDir: string, baseDir: string): Promise<string[]> {
    let results: string[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (entry.name === "manifest.json" || entry.name.startsWith(".")) continue;
      const full = path.join(currentDir, entry.name);
      const rel = path.relative(baseDir, full);
      if (entry.isDirectory()) {
        const sub = await scanDir(full, baseDir);
        results = results.concat(sub);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (supported.has(ext)) results.push(rel.replace(/\\/g, "/"));
      }
    }
    return results;
  }

  async function generateManifest() {
    await ensureDir(imagesDir);
    const files = await scanDir(imagesDir, imagesDir);
    const json = JSON.stringify(files, null, 2);
    await fsp.writeFile(manifestPath, json, "utf8");
  }

  return {
    name: "generate-public-images-manifest",
    apply: "serve",
    async configureServer(server) {
      await generateManifest();
      server.watcher.add(imagesDir);
      const debounced = debounce(async () => {
        try { await generateManifest(); } catch {}
      }, 150);
      server.watcher.on("add", debounced);
      server.watcher.on("unlink", debounced);
      server.watcher.on("change", debounced);
    },
    async buildStart() {
      await generateManifest();
    },
  } as Plugin;

  function debounce<T extends (...args: any[]) => any>(fn: T, wait: number) {
    let timer: any;
    return (...args: Parameters<T>) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === 'gh' ? `/${process.env.GITHUB_REPOSITORY?.split('/')?.[1] ?? ''}/` : '/',
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    imagesManifestPlugin(),
    mode === 'development' && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
