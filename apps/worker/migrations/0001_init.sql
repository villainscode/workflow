-- 문서 탐색 워크플로우 D1 스키마(원본). 로컬 사이트의 색인 테이블(site/server/schema.ts)에 workspace와 id 관계를 더했다.
-- 계획·설명: REQUIREMENT-4.0.md 5.2

CREATE TABLE workspace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 상단 메뉴(대분류). 원래 docs/_site/categories.yaml
CREATE TABLE top_menu (
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- 좌측 메뉴(폴더). 원래 docs/_site/menus.yaml
CREATE TABLE menu (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  slug TEXT NOT NULL,
  category_key TEXT NOT NULL,
  parent_id INTEGER REFERENCES menu(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);

-- 문서. 원래 meta.yaml. 하위 문서는 parent_id(같은 메뉴). slug는 메뉴 안에서 깊이와 상관없이 하나(D-34)
-- 휴지통: 지운 문서와 그 하위 문서는 deleted_at·trash_id(휴지통 항목 = 지운 문서의 id)를 갖는다. 원래 메뉴 slug는 trash_menu에 남기고,
-- 그 메뉴가 지워지면 menu_id는 NULL이 된다(복원할 때 메뉴를 고른다). slug 중복 검사는 휴지통 밖 문서끼리만 한다
CREATE TABLE document (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  menu_id INTEGER REFERENCES menu(id),
  slug TEXT NOT NULL,
  parent_id INTEGER REFERENCES document(id),
  sort INTEGER,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  type TEXT,
  sdlc TEXT,
  status TEXT NOT NULL,
  current_version TEXT NOT NULL,
  notion_url TEXT,
  gdrive_url TEXT,
  origin_url TEXT,
  deleted_at TEXT,
  trash_id INTEGER,
  trash_menu TEXT
);
CREATE UNIQUE INDEX document_slug ON document (menu_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX document_trash ON document (workspace_id, trash_id);

-- 버전. 원래 meta.yaml versions[] + 버전 폴더. UNIQUE가 동시 저장 충돌을 막는다(5.4)
CREATE TABLE document_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES document(id),
  version TEXT NOT NULL,
  note TEXT,
  source TEXT,
  created_at TEXT,
  entry TEXT NOT NULL,
  UNIQUE (document_id, version)
);

-- 버전의 파일. path는 버전 폴더 기준 상대 경로. 본문은 R2 ws/<workspace_id>/blobs/<sha256>
CREATE TABLE version_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES document_version(id),
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  is_entry INTEGER NOT NULL,
  UNIQUE (version_id, path)
);
CREATE INDEX version_file_sha ON version_file (sha256);

-- 검색. 최신 버전 대표 파일 본문. trigram이라 한국어 부분 일치(LIKE '%리뷰%')를 색인으로 찾는다(P0에서 원격 D1 확인)
CREATE VIRTUAL TABLE search USING fts5(workspace_id UNINDEXED, document_id UNINDEXED, title, body, tokenize = 'trigram');
