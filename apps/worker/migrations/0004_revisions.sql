-- 수정본(5.0 M1): 편집 중 자동 저장마다 쌓이는 이력. 버전(v0.x)과 따로 둔다(spec/REQUIREMENT-5.0.md 5.1)
-- 파일 목록(매니페스트)은 R2 blob(JSON)이 정본이고, D1은 그 주소와 목록·관계를 둔다

CREATE TABLE document_revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES document(id),
  rev INTEGER NOT NULL,                 -- 문서 안 일련번호(1부터)
  base_version TEXT NOT NULL,           -- 작업을 시작한 버전
  manifest_sha TEXT NOT NULL,           -- R2 매니페스트 blob: { entry, files: [{ path, sha256, size, mime }] }
  author_id INTEGER REFERENCES app_user(id),
  source TEXT NOT NULL,                 -- human | agent | office | restore
  summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, rev)
);

-- 작업본: 문서마다 지금 수정본 하나. 저장할 때 rev를 비교해 동시 저장을 막는다
CREATE TABLE document_head (
  document_id INTEGER PRIMARY KEY REFERENCES document(id),
  rev INTEGER NOT NULL,
  base_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 편집기에서 올린 이미지. 본문은 R2 ws/<id>/blobs/<sha256>
CREATE TABLE asset (
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_by INTEGER REFERENCES app_user(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, sha256)
);

-- 버전으로 올린 수정본(그 수정본은 보존 정책에서 지우지 않는다)
ALTER TABLE document_version ADD COLUMN revision_id INTEGER REFERENCES document_revision(id);
