-- 활동 기록(4.0 P5): 누가(사람·Claude Code) 언제 무엇을 바꿨는지. 쓰기 API가 끝날 때 남긴다
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  user_id INTEGER REFERENCES app_user(id),
  agent TEXT,
  action TEXT NOT NULL,
  target TEXT,
  version TEXT,
  at TEXT NOT NULL
);
CREATE INDEX activity_ws ON activity (workspace_id, id);
