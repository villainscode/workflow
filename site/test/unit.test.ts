// 서버 없이 확인하는 규칙: 버전 번호, slug, 메뉴 원본(yaml) 읽기·쓰기, 색인 경고
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { nextMajor, nextVersion, slugify } from "../server/store.ts";
import { loadSite, saveSite } from "../server/sitefiles.ts";
import { scanDocs } from "../server/scan.ts";
import { DDL } from "../server/schema.ts";
import { makeWorkspace, sleep } from "./helpers.ts";
import { alignBoxes, distributeBoxes } from "../web/src/editor/align.ts";

test("TC-VER-01 첫 버전은 v0.0, 이후 수정마다 minor +1", () => {
  assert.equal(nextVersion([]), "v0.0");
  assert.equal(nextVersion(["v0.0"]), "v0.1");
  assert.equal(nextVersion(["v0.0", "v0.1", "v0.9"]), "v0.10");
  assert.equal(nextVersion(["v1.0"]), "v1.1");
  assert.equal(nextVersion(["v0.3", "v1.0", "v0.2"]), "v1.1", "가장 높은 버전 기준");
  assert.equal(nextVersion(["draft", "v0.0"]), "v0.1", "형식이 아닌 이름은 무시");
});

test("TC-VER-02 정식 확정 번호: v0.x → v1.0, v1.x → v2.0", () => {
  assert.equal(nextMajor(["v0.0", "v0.3"]), "v1.0");
  assert.equal(nextMajor(["v0.0", "v1.0", "v1.2"]), "v2.0");
  assert.equal(nextMajor([]), "v1.0");
});

test("TC-VER-03 slug: 파일 이름에서 확장자를 떼고 영문 소문자·숫자·하이픈만", () => {
  assert.equal(slugify("Review Gate.html"), "review-gate");
  assert.equal(slugify("--A__B--"), "a-b");
  assert.equal(slugify("한글만.md"), "doc", "남는 글자가 없으면 doc");
});

test("TC-SITE-01 categories.yaml·menus.yaml을 합쳐 읽는다", (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const site = loadSite(ws.docs);
  assert.deepEqual(site.categories.map((c) => c.key), ["sdlc", "agent"]);
  assert.equal(site.categories[0].menus![0].menus![0].slug, "review", "하위 메뉴 유지");
  assert.deepEqual(site.orphanTrees, []);
});

test("TC-SITE-02 저장할 때 맨 위 주석을 유지하고, 내용이 같으면 파일을 다시 쓰지 않는다", async (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const menus = join(ws.docs, "_site/menus.yaml");
  const before = statSync(menus).mtimeMs;
  await sleep(20);
  saveSite(ws.docs, loadSite(ws.docs));
  assert.equal(statSync(menus).mtimeMs, before, "같은 내용이면 쓰지 않음");

  const site = loadSite(ws.docs);
  site.categories[1].menus!.push({ slug: "new-menu", name: "새 메뉴" });
  saveSite(ws.docs, site);
  const raw = readFileSync(menus, "utf8");
  assert.match(raw, /^# 메뉴 트리 주석\n/);
  assert.match(raw, /slug: new-menu/);
  assert.match(readFileSync(join(ws.docs, "_site/categories.yaml"), "utf8"), /^# 상단 메뉴 주석\n/);
});

test("TC-SITE-03 categories.yaml에 없는 대분류의 트리는 지우지 않고 남긴다", (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const menus = join(ws.docs, "_site/menus.yaml");
  writeFileSync(menus, readFileSync(menus, "utf8") + "  ghost:\n    - slug: lost\n      name: 고아\n");
  assert.deepEqual(loadSite(ws.docs).orphanTrees, ["ghost"]);
  saveSite(ws.docs, loadSite(ws.docs));
  assert.match(readFileSync(menus, "utf8"), /ghost:\n\s+- slug: lost/);
});

test("TC-IDX-01 문제가 있어도 색인을 멈추지 않고 경고로 모은다", (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  mkdirSync(join(ws.docs, "unknown-menu/x"), { recursive: true });               // menus.yaml에 없는 메뉴
  mkdirSync(join(ws.docs, "notes/no-meta"), { recursive: true });                // meta.yaml 없음
  mkdirSync(join(ws.docs, "notes/bad-yaml"), { recursive: true });
  writeFileSync(join(ws.docs, "notes/bad-yaml/meta.yaml"), "title: [깨짐\n");    // yaml 오류
  mkdirSync(join(ws.docs, "notes/no-entry/v0.0"), { recursive: true });
  writeFileSync(join(ws.docs, "notes/no-entry/v0.0/other.md"), "x");
  writeFileSync(join(ws.docs, "notes/no-entry/meta.yaml"),
    "title: 대표 파일 없음\ncategory: sdlc\nmenu: notes\nkind: markdown\ncurrent: v0.1\nversions:\n  - version: v0.0\n    entry: main.md\n  - version: v0.1\n    entry: main.md\n");
  mkdirSync(join(ws.docs, "_trash/20260101000000--notes--old"), { recursive: true }); // _ 폴더는 건너뜀

  const sqlite = new Database(":memory:");
  sqlite.exec(DDL);
  const warnings = scanDocs(drizzle(sqlite), ws.docs, ws.root);
  const has = (re: RegExp) => assert.ok(warnings.some((w) => re.test(w)), `경고 ${re} 없음: ${warnings.join(" / ")}`);
  has(/unknown-menu: menus.yaml에 없는 메뉴/);
  has(/no-meta: meta.yaml 없음/);
  has(/bad-yaml\/meta.yaml: yaml 오류/);
  has(/no-entry\/v0.0: entry 파일\(main.md\) 없음/);
  has(/no-entry\/v0.1: 버전 폴더 없음/);
  assert.ok(!warnings.some((w) => w.includes("_trash")));
  const titles = sqlite.prepare("SELECT title FROM document ORDER BY title").all().map((r: any) => r.title);
  assert.ok(titles.includes("샘플 프로세스 가이드") && titles.includes("주간 회의록"), "정상 문서는 색인됨");
});

test("TC-VE-02 정렬·분배(요소 편집기 공통 계산): 여럿은 감싸는 상자 기준, 하나는 바깥 기준, 분배는 처음·끝 고정에 간격 같게", () => {
  const a = { left: 100, top: 50, width: 200, height: 100 }, b = { left: 400, top: 300, width: 100, height: 50 }, c = { left: 900, top: 120, width: 100, height: 80 };
  assert.deepEqual(alignBoxes([a, b], "left").map((x) => x.left), [100, 100]);
  assert.deepEqual(alignBoxes([a, b], "right").map((x) => x.left), [300, 400]);
  assert.deepEqual(alignBoxes([a, b], "hcenter").map((x) => x.left), [200, 250]);
  assert.deepEqual(alignBoxes([a, b], "bottom").map((x) => x.top), [250, 300]);
  assert.deepEqual(alignBoxes([a, b], "vcenter").map((x) => x.top), [150, 175]);
  // 하나면 바깥(슬라이드) 기준
  assert.deepEqual(alignBoxes([a], "hcenter", { left: 0, top: 0, width: 1920, height: 1080 })[0], { ...a, left: 860 });
  // 분배: 순서와 상관없이 위치 순으로, 처음(a)·끝(c)은 그대로, 사이 간격 (1000-100-400)/2 = 250
  const d = distributeBoxes([c, a, b], "x");
  assert.deepEqual(d.map((x) => x.left), [900, 100, 550]);
  assert.deepEqual(distributeBoxes([a, b], "x"), [a, b]);
});
