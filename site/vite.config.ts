import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// svgedit 캔버스(6.0 V4): 묶인 dist(gzip +326kB) 대신 소스를 쓰고, 쓰지 않는 PDF 내보내기(jspdf·svg2pdf)는 빈 모듈로 바꾼다(+64kB, V0 스파이크 2)
const svgcanvas = resolve(dirname(createRequire(import.meta.url).resolve("@svgedit/svgcanvas/package.json")), "svgcanvas.js");

const api = `http://127.0.0.1:${process.env.PORT ?? 5174}`;

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@svgedit\/svgcanvas$/, replacement: svgcanvas },
      { find: /^jspdf$/, replacement: resolve(here, "web/src/editor/stubs/jspdf.ts") },
      { find: /^svg2pdf\.js$/, replacement: resolve(here, "web/src/editor/stubs/empty.ts") },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 8000),
    strictPort: true, // 다른 포트로 바꿔 뜨지 않는다. 포트는 predev(scripts/free-ports.mjs)가 비운다
    proxy: { "/api": api, "/files": api },
  },
  // Cloudflare 빌드(apps/worker build:web)는 WEB_OUT으로 Worker 정적 파일 폴더에 낸다
  build: { outDir: process.env.WEB_OUT ?? "../dist", emptyOutDir: true },
});
