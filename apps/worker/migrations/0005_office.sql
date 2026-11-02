-- 오피스 편집 세션(6.0 VO, D-59): 문서마다 하나. 살아 있는 동안(expires_at, ms) 그 문서의 다른 쓰기를 막는다(작업본 잠금)
CREATE TABLE office_session (
  document_id INTEGER PRIMARY KEY REFERENCES document(id),
  doc_key TEXT NOT NULL,               -- 오피스 서버 문서 키(기준 버전·rev에서 나온다)
  rev INTEGER NOT NULL,
  base_version TEXT NOT NULL,
  user_id INTEGER REFERENCES app_user(id),
  expires_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL          -- 세션을 처음 연 시각(ms). 연장은 MAX_SESSION까지(V6 보안 점검)
);
