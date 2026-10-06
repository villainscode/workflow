import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = `http://127.0.0.1:${process.env.PORT ?? 5174}`;

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": api, "/files": api },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
