#!/usr/bin/env bash
# PreToolUse: block edits to protected files/commands (block MUST be exit 2, allow exit 0).
# Fail-closed: when jq is missing or JSON is malformed, the write paths block unconditionally
# (D-01, GUARD-01). Stderr messages stay Korean to match the existing [harness:guard] convention.

# (1) FAIL-CLOSED PREAMBLE with cause-specific messages (D-03).
# jq present-check runs BEFORE reading stdin (cat), so a missing jq blocks here immediately.
if ! command -v jq >/dev/null 2>&1; then
  echo "[harness:guard] jq 미설치 → fail-closed 차단 (jq 설치 후 재시도)" >&2
  exit 2
fi
input=$(cat)
if ! printf '%s' "$input" | jq empty >/dev/null 2>&1; then
  echo "[harness:guard] JSON 파싱 실패 → fail-closed 차단" >&2
  exit 2
fi

# (2) SINGLE-SOURCE patterns from lib-protected.sh: PROTECTED_RE(.env · 시크릿 파일 · 키 파일 —
# 항상 차단)와 MIGRATION_RE(db/migration/ — 기존 파일 차단, 새 파일은 확인 요청, 아래 3d).
# Both branches (file and Bash) consume these ONE definitions — no second definition, no drift.
source "$(dirname "${BASH_SOURCE[0]}")/lib-protected.sh"
LOG_EVENT="$(dirname "${BASH_SOURCE[0]}")/log-event.sh"

tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

# (2b) GUARD-06 loop brake: N consecutive identical (tool + input) calls block.
# Signature ring lives in logs/ (gitignored). Any different call resets the run,
# so legit reruns with edits in between never trip it. All writes best-effort —
# a ring failure must never change the guard's verdict.
DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RING="$DIR/logs/.recent-calls"
LOOP_N="${GUARD_LOOP_N:-4}"   # block the (N+1)th identical call in a row
sig=$(printf '%s' "$input" | jq -cS '{t:.tool_name,i:.tool_input}' 2>/dev/null | cksum | cut -d' ' -f1)
if [ -n "$sig" ] && [ -f "$RING" ] \
  && [ "$(tail -"$LOOP_N" "$RING" 2>/dev/null | grep -cxF "$sig")" -ge "$LOOP_N" ]; then
  echo "[harness:guard] 루프 감지: 동일 툴+동일 인자 $((LOOP_N + 1))회 연속 — 같은 시도 반복 금지, 접근을 바꾸거나 원인을 먼저 조사하라" >&2
  bash "$LOG_EVENT" PreToolUse "$tool" block "" "loop-detected"
  exit 2
fi
if [ -n "$sig" ]; then
  { mkdir -p "$DIR/logs" && printf '%s\n' "$sig" >> "$RING" \
    && tail -20 "$RING" > "$RING.tmp" && mv "$RING.tmp" "$RING"; } 2>/dev/null || true
fi

# (3a) Bash: block only when a WRITE OPERATOR targets a protected path (GUARD-03).
# Never a bare substring match — a read that merely mentions a protected keyword (grep,
# git log, git commit -m) or an fd redirect (2>/dev/null) is allowed. Pipe/variable/heredoc
# indirection is a documented ceiling (CONTEXT Claude's-Discretion; STATE C4) — best-effort.
if [ "$tool" = "Bash" ]; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
  # (3a-0) GUARD-05: forbidden commands per safety.md/AGENTS.md — force push,
  # reset --hard, --no-verify, history rewrite, docker volume wipe, curl|sh,
  # destructive SQL via a DB client (WHERE-less DELETE included).
  if printf '%s' "$cmd" | grep -Eq "$DANGER_RE" \
    || printf '%s' "$cmd" | grep -Eq "$DANGER_PIPE_RE"; then
    echo "[harness:guard] 위험 명령 차단(safety.md 금지 항목): $cmd" >&2
    bash "$LOG_EVENT" PreToolUse Bash block ""
    exit 2
  fi
  # (3a-0b) GUARD-08: recursive delete of a critical target (project root, `/`,
  # $HOME). Needs BOTH the rm-recursive shape and a critical target, so ordinary
  # `rm -rf build/` is untouched. Complements settings.json deny, which only
  # prefix-matches `rm -rf` and so misses `rm -r -f` / `sudo rm -rf`.
  if printf '%s' "$cmd" | grep -Eq "$DANGER_RM_RE" \
    && printf '%s' "$cmd" | grep -Eq "$DANGER_RM_TARGET_RE"; then
    echo "[harness:guard] 재귀 삭제 차단(safety.md — 루트/홈/프로젝트 전체): $cmd" >&2
    bash "$LOG_EVENT" PreToolUse Bash block ""
    exit 2
  fi
  if printf '%s' "$cmd" | grep -Eq "$DANGER_SQL_RE"; then
    if printf '%s' "$cmd" | grep -Eqi "$DANGER_SQL_KW_RE" \
      || { printf '%s' "$cmd" | grep -Eqi 'DELETE[[:space:]]+FROM' \
           && ! printf '%s' "$cmd" | grep -Eqi '[[:space:]]WHERE[[:space:]]'; }; then
      echo "[harness:guard] 파괴적 SQL 차단(DROP/TRUNCATE/WHERE 없는 DELETE): $cmd" >&2
      bash "$LOG_EVENT" PreToolUse Bash block ""
      exit 2
    fi
  fi
  # writes_to <ERE>: the command has a write operator aimed at a path matching <ERE>.
  writes_to() {
    printf '%s' "$cmd" | grep -Eq "(>>?|(^|[[:space:]])tee[[:space:]])[[:space:]]*['\"]?[^[:space:]|;&<>]*$1" \
      || printf '%s' "$cmd" | grep -Eq "(sed|perl)[[:space:]]+-i[^|;&]*$1" \
      || printf '%s' "$cmd" | grep -Eq "(^|[;&|][[:space:]]*)${CMD_PFX}(cp|mv|install)[[:space:]][^|;&]*$1" \
      || printf '%s' "$cmd" | grep -Eq "(^|[;&|][[:space:]]*)${CMD_PFX}(rm|unlink|shred|truncate|touch)[[:space:]][^|;&]*$1"
  }
  if writes_to "$PROTECTED_RE"; then
    echo "[harness:guard] Bash 쓰기 차단(보호 경로): $cmd" >&2
    bash "$LOG_EVENT" PreToolUse Bash block ""
    exit 2
  fi
  # Flyway 경로는 Bash 로 쓰지 않는다 — 새 마이그레이션은 Write 도구로 만들면 사용자 확인을 거친다.
  if writes_to "$MIGRATION_RE"; then
    echo "[harness:guard] Bash 로 db/migration/ 쓰기 차단 — 기존 마이그레이션은 수정 · 삭제 금지, 새 파일은 Write 도구로 만들어 사용자 확인을 받는다: $cmd" >&2
    bash "$LOG_EVENT" PreToolUse Bash block "" "migration-bash"
    exit 2
  fi
  # The command string is treated as opaque data — never eval / sh -c.
  bash "$LOG_EVENT" PreToolUse Bash allow ""
  exit 0
fi

# (3b) Write tools (Write/Edit/MultiEdit/NotebookEdit): read file_path OR notebook_path.
# NotebookEdit uses notebook_path, so BOTH keys must be read (GUARD-02, Pitfall 2).
p=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
if printf '%s' "$p" | grep -Eq "$PROTECTED_RE"; then
  echo "[harness:guard] 보호 파일 수정 차단: $p" >&2
  bash "$LOG_EVENT" PreToolUse "$tool" block "$p"
  exit 2
fi

# (3c) GUARD-04: block hardcoded secrets in the write CONTENT (path-independent).
# Fields differ per tool; SECRETS_RE is length-anchored so benign content passes.
content=$(printf '%s' "$input" | jq -r '.tool_input.content // .tool_input.new_string // .tool_input.new_source // (.tool_input.edits[]?.new_string) // empty' 2>/dev/null)
if [ -n "$content" ] && printf '%s' "$content" | grep -Eq "$SECRETS_RE"; then
  echo "[harness:guard] 시크릿 내용 차단(하드코딩 시크릿 감지)" >&2
  bash "$LOG_EVENT" PreToolUse "$tool" block "$p"
  exit 2
fi

# (3d) Flyway 마이그레이션 정책(safety.md): 이미 있는 파일은 수정 금지(체크섬), 새 파일은
# Write 도구로만 만들고 매번 사용자 확인을 받는다(permissionDecision=ask — 거절하면 쓰지 않는다).
if printf '%s' "$p" | grep -Eq "$MIGRATION_RE"; then
  if [ -e "$p" ]; then
    echo "[harness:guard] 기존 Flyway 마이그레이션 수정 차단(적용된 파일은 체크섬 때문에 고치지 않는다 — 새 버전 파일로 바로잡는다): $p" >&2
    bash "$LOG_EVENT" PreToolUse "$tool" block "$p" "migration-existing"
    exit 2
  fi
  if [ "$tool" != "Write" ]; then
    echo "[harness:guard] 새 Flyway 마이그레이션은 Write 도구로만 만든다: $p" >&2
    bash "$LOG_EVENT" PreToolUse "$tool" block "$p" "migration-tool"
    exit 2
  fi
  bash "$LOG_EVENT" PreToolUse "$tool" ask "$p" "migration-new"
  jq -cn --arg p "$p" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",
    permissionDecisionReason:("새 Flyway 마이그레이션 생성: " + $p + " — 기존 마이그레이션은 수정하지 않았는지, expand-contract(구버전 앱과 동시 운영 가능)인지 확인 후 승인하세요.")}}'
  exit 0
fi

bash "$LOG_EVENT" PreToolUse "$tool" allow "$p"
exit 0
