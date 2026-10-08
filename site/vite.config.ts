import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = `http://127.0.0.1:${process.env.PORT ?? 5174}`;

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true, // 다른 포트로 바꿔 뜨지 않는다. 포트는 predev(scripts/free-ports.mjs)가 비운다
    proxy: { "/api": api, "/files": api },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
