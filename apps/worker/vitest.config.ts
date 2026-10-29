import { mkdirSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Workers 런타임(Miniflare) 안에서 도는 테스트. D1·R2는 테스트마다 따로 비어 있는 로컬 저장소다
export default defineConfig(async () => {
  mkdirSync("public", { recursive: true }); // wrangler assets 폴더(화면 빌드 결과). 테스트에서는 비어 있어도 된다
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: {
        TEST_MIGRATIONS: migrations, SIGNING_KEY: "test-signing-key", ADMIN_TOKEN: "test-admin",
        DEV_LOGIN: "1", SUPERADMIN_EMAILS: "owner@test.com", GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret",
      } },
    })],
    // test-ui/는 node:test + puppeteer(npm run test:ui)라 넣지 않는다
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
