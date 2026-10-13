import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// 색인 테이블. 원본은 docs/의 yaml과 파일이고, 서버가 시작할 때마다 다시 만든다.

// 상단 메뉴(대분류). 원본은 docs/_site/categories.yaml. 좌측 메뉴(menu)와 별도 테이블이다
export const topMenus = sqliteTable("top_menu", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  sort: integer("sort").notNull(),
});

export const menus = sqliteTable("menu", {
  slug: text("slug").primaryKey(),
  categoryKey: text("category_key").notNull(),
  parentSlug: text("parent_slug"),
  name: text("name").notNull(),
  sort: integer("sort").notNull(),
});

export const documents = sqliteTable("document", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  menuSlug: text("menu_slug").notNull(),
  slug: text("slug").notNull(),
  // 하위 문서면 상위 문서 slug(같은 메뉴). 원본은 폴더 위치(docs/<메뉴>/<상위>/<하위>/)
  parentSlug: text("parent_slug"),
  // 같은 자리(메뉴 최상위 또는 같은 상위 문서) 안의 순서. meta.yaml의 order. 없으면 제목순으로 뒤에
  sort: integer("sort"),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  type: text("type"),
  sdlc: text("sdlc"),
  status: text("status").notNull(),
  currentVersion: text("current_version").notNull(),
  notionUrl: text("notion_url"),
  gdriveUrl: text("gdrive_url"),
  originUrl: text("origin_url"),
  deletedAt: text("deleted_at"),
});

export const documentVersions = sqliteTable("document_version", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  documentId: integer("document_id").notNull(),
  version: text("version").notNull(),
  note: text("note"),
  source: text("source"),
  createdAt: text("created_at"),
});

export const versionFiles = sqliteTable("version_file", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  versionId: integer("version_id").notNull(),
  path: text("path").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  isEntry: integer("is_entry", { mode: "boolean" }).notNull(),
});

export const DDL = `
DROP TABLE IF EXISTS search;
DROP TABLE IF EXISTS version_file;
DROP TABLE IF EXISTS document_version;
DROP TABLE IF EXISTS document;
DROP TABLE IF EXISTS menu;
DROP TABLE IF EXISTS category;
DROP TABLE IF EXISTS top_menu;
CREATE TABLE top_menu (key TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE menu (slug TEXT PRIMARY KEY, category_key TEXT NOT NULL REFERENCES top_menu(key),
  parent_slug TEXT REFERENCES menu(slug), name TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE document (id INTEGER PRIMARY KEY AUTOINCREMENT, menu_slug TEXT NOT NULL REFERENCES menu(slug),
  slug TEXT NOT NULL, parent_slug TEXT, sort INTEGER, title TEXT NOT NULL, kind TEXT NOT NULL, type TEXT, sdlc TEXT, status TEXT NOT NULL,
  current_version TEXT NOT NULL, notion_url TEXT, gdrive_url TEXT, origin_url TEXT, deleted_at TEXT, UNIQUE(menu_slug, slug));
CREATE TABLE document_version (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES document(id),
  version TEXT NOT NULL, note TEXT, source TEXT, created_at TEXT, UNIQUE(document_id, version));
CREATE TABLE version_file (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL REFERENCES document_version(id),
  path TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, is_entry INTEGER NOT NULL);
-- 검색 색인. trigram이라 LIKE '%리뷰%' 같은 부분 일치를 색인으로 찾는다(한국어 조사가 붙어도 찾힌다)
CREATE VIRTUAL TABLE search USING fts5(document_id UNINDEXED, title, body, tokenize = 'trigram');
`;
