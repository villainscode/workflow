/**
 * 사용자 콘텐츠 주소의 서명 토큰(REQUIREMENT-4.0 5.5). 형식: <workspace id>.<만료 초>.<서명>
 * 토큰은 워크스페이스 단위다. 문서 사이 상대 링크(../../다른메뉴/문서/v0.0/x.html)가 같은 토큰으로 그대로 열려야 하기 때문이다.
 * 만료는 12시간 단위로 끊어, 같은 12시간 안에는 같은 주소가 나와 브라우저 캐시가 듣는다(유효 12~24시간).
 */

const WINDOW = 12 * 3600;
const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url((await crypto.subtle.sign("HMAC", k, enc.encode(msg))).slice(0, 18));
}

export async function contentToken(key: string, wsId: number, now = Date.now() / 1000): Promise<string> {
  const exp = (Math.floor(now / WINDOW) + 2) * WINDOW;
  return `${wsId}.${exp}.${await sign(key, `${wsId}.${exp}`)}`;
}

/** 맞으면 워크스페이스 id, 위조·만료·형식 오류면 null */
export async function verifyContentToken(key: string, token: string, now = Date.now() / 1000): Promise<number | null> {
  const m = /^(\d+)\.(\d+)\.([\w-]+)$/.exec(token);
  if (!m) return null;
  const [, ws, exp, sig] = m;
  if (Number(exp) < now) return null;
  const expected = await sign(key, `${ws}.${exp}`);
  // 길이가 같을 때만 비교하고, 글자마다 다 비교한다(시간 차로 서명을 짐작하지 못하게)
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? Number(ws) : null;
}
