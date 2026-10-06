import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// 색인 테이블. 원본은 docs/의 yaml과 파일이고, 서버가 시작할 때마다 다시 만든다.

export const categories = sqliteTable("category", {
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
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  type: text("type"),
  sdlc: text("sdlc"),
  status: text("status").notNull(),
  currentVersion: text("current_version").notNull(),
  notionUrl: text("notion_url"),
  gdriveUrl: text("gdrive_url"),
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
DROP TABLE IF EXISTS version_file;
DROP TABLE IF EXISTS document_version;
DROP TABLE IF EXISTS document;
DROP TABLE IF EXISTS menu;
DROP TABLE IF EXISTS category;
CREATE TABLE category (key TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE menu (slug TEXT PRIMARY KEY, category_key TEXT NOT NULL REFERENCES category(key),
  parent_slug TEXT REFERENCES menu(slug), name TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE document (id INTEGER PRIMARY KEY AUTOINCREMENT, menu_slug TEXT NOT NULL REFERENCES menu(slug),
  slug TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, type TEXT, sdlc TEXT, status TEXT NOT NULL,
  current_version TEXT NOT NULL, notion_url TEXT, gdrive_url TEXT, deleted_at TEXT, UNIQUE(menu_slug, slug));
CREATE TABLE document_version (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES document(id),
  version TEXT NOT NULL, note TEXT, source TEXT, created_at TEXT, UNIQUE(document_id, version));
CREATE TABLE version_file (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL REFERENCES document_version(id),
  path TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, is_entry INTEGER NOT NULL);
`;
