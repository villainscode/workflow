-- 로그인·워크스페이스 멤버·초대(4.0 P4). Google 로그인만, 초대받은 사람만 들어온다(SUPERADMIN_EMAILS는 예외)

CREATE TABLE app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  picture TEXT,
  google_sub TEXT UNIQUE,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- 로그인 세션. id는 쿠키 토큰의 sha256(토큰 자체는 저장하지 않는다)
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX session_user ON session (user_id);

CREATE TABLE member (
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  user_id INTEGER NOT NULL REFERENCES app_user(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- 초대 링크. 한 번 쓰면 끝, 7일 유효. email을 주면 그 계정만 받을 수 있다. id는 링크 토큰의 sha256
CREATE TABLE invite (
  id TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  email TEXT,
  created_by INTEGER REFERENCES app_user(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by INTEGER REFERENCES app_user(id),
  used_at TEXT
);
CREATE INDEX invite_ws ON invite (workspace_id);
