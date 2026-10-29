/**
 * 버전 규칙(.claude/rules/docs-workflow.md "버전 규칙"). 최초 v0.0(화면에는 draft), 수정마다 v0.1, v0.2 …, 정식 확정은 다음 major(v1.0, v2.0).
 * 서버·화면·MCP가 같이 쓴다.
 */

export const VERSION_RE = /^v(\d+)\.(\d+)$/;

/** 화면에 보일 버전 이름. 첫 버전(v0.0)은 "draft"로 보여준다 */
export const versionLabel = (v: string) => (v === "v0.0" ? "draft" : v);

/** 다음 버전 번호. 처음 만들 때는 v0.0, 그 뒤 수정마다 v0.1, v0.2 … */
export function nextVersion(versions: string[]): string {
  const nums = versions.map((v) => VERSION_RE.exec(v)).filter((m) => m !== null).map((m) => [Number(m[1]), Number(m[2])]);
  if (nums.length === 0) return "v0.0";
  nums.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [major, minor] = nums[nums.length - 1];
  return `v${major}.${minor + 1}`;
}

/** 다음 정식 버전 번호: 가장 높은 major + 1 (v0.x → v1.0, v1.2 → v2.0) */
export function nextMajor(versions: string[]): string {
  const majors = versions.map((v) => VERSION_RE.exec(v)).filter((m) => m !== null).map((m) => Number(m[1]));
  return `v${(majors.length ? Math.max(...majors) : 0) + 1}.0`;
}
