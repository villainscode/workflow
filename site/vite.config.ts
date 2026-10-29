import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = `http://127.0.0.1:${process.env.PORT ?? 5174}`;

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 8000),
    strictPort: true, // 다른 포트로 바꿔 뜨지 않는다. 포트는 predev(scripts/free-ports.mjs)가 비운다
    proxy: { "/api": api, "/files": api },
  },
  // Cloudflare 빌드(apps/worker build:web)는 WEB_OUT으로 Worker 정적 파일 폴더에 낸다
  build: { outDir: process.env.WEB_OUT ?? "../dist", emptyOutDir: true },
});
