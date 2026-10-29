#!/usr/bin/env bash
# pretool-guard.sh 정책 회귀 시험 — 보호 경로 · Flyway(기존 차단 · 새 파일 ask) · 시크릿 본문 · 위험 명령.
# 실행: bash .claude/hooks/tests/pretool-guard.test.sh  (stacks/bash.sh 가 훅 변경 시 자동 실행)
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"; G="$R/.claude/hooks/pretool-guard.sh"
S="$(mktemp -d)"; trap 'rm -rf "$S"' EXIT
export CLAUDE_PROJECT_DIR="$S/guardtest" GUARD_LOOP_N=999
mkdir -p "$S/guardtest"
M="$R/src/main/resources/db/migration/ddl"; EX=$(ls "$M" | head -1)
fail=0
t() { local exp="$1" in="$2" name="$3" out rc act=allow
  out=$(printf '%s' "$in" | bash "$G" 2>&1); rc=$?
  [ $rc -eq 2 ] && act=block
  printf '%s' "$out" | grep -q '"permissionDecision":"ask"' && act=ask
  if [ "$act" = "$exp" ]; then printf 'OK   %-5s %s\n' "$act" "$name"; else printf 'FAIL %-5s (기대 %s) %s\n' "$act" "$exp" "$name"; fail=1; fi; }
W() { jq -cn --arg t "$1" --arg p "$2" --arg c "${3:-x}" '{tool_name:$t,tool_input:{file_path:$p,content:$c,new_string:$c}}'; }
B() { jq -cn --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'; }
SEC="secr""ets"; KEY="AKI""AABCDEFGHIJKLMNOP"

t ask   "$(W Write "$M/V99__new.sql")"            "Write 새 마이그레이션 → 확인 요청"
t block "$(W Write "$M/$EX")"                     "Write 기존 마이그레이션 덮어쓰기"
t block "$(W Edit "$M/$EX")"                      "Edit 기존 마이그레이션"
t block "$(W Edit "$M/V99__x.sql")"               "Edit 없는 마이그레이션(Write 만 허용)"
t block "$(B "echo x > $M/V99__x.sql")"           "Bash 리다이렉트 → 마이그레이션"
t block "$(B "rm $M/$EX")"                        "Bash rm 기존 마이그레이션"
t allow "$(B "ls $M && cat $M/$EX")"              "Bash 마이그레이션 읽기"
t allow "$(W Write "$R/src/main/kotlin/x/SecretsManagerConfig.kt")" "Write SecretsManagerConfig.kt"
t allow "$(W Write "$R/src/main/kotlin/x/JwtSecretProperties.kt")"  "Write JwtSecretProperties.kt"
t allow "$(W Write "$R/src/main/kotlin/x/jwt_secret_util.kt")"      "Write jwt_secret_util.kt"
t block "$(W Write "$R/config/$SEC.yaml")"        "Write secrets.yaml"
t block "$(W Write "$R/config/secret/a.txt")"     "Write secret/ 디렉터리"
t block "$(W Write "$R/keys/server.pem")"         "Write .pem"
t block "$(W Write "$R/.env.local")"              "Write .env.local"
t allow "$(W Write "$R/src/environment.kt")"      "Write environment.kt"
t block "$(B "echo a > $SEC.json")"               "Bash > secrets.json"
t block "$(B "cp a.txt '$SEC.yaml'")"             "Bash cp → 'secrets.yaml'"
t allow "$(B "grep -rn secret src")"              "Bash grep secret"
t block "$(W Write "$R/x.kt" "val k = \"$KEY\"")" "Write 본문 AWS 키"
t block "$(B "git push --force origin x")"        "Bash force push"
t allow "$(W Write "$R/docs/rules/x.md")"         "Write 일반 문서"
echo "--- ask 로그:"; jq -r 'select(.decision=="ask")|"\(.reason) \(.target)"' "$S"/guardtest/logs/*.jsonl
exit $fail
