/**
 * http로 들어온 요청을 같은 주소의 https로 보낸다. APP_ORIGIN이 https인 배포(staging·production)에서만.
 * http로 열면 Google 로그인 콜백 주소가 http가 되어 redirect_uri_mismatch가 나고, 세션 쿠키에 Secure가 빠진다.
 * 정적 화면(index.html)은 Worker를 거치지 않으므로 화면 쪽(main.tsx)에서도 https로 옮긴다.
 */
export function toHttps(request: Request, env: { APP_ORIGIN: string }): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || !env.APP_ORIGIN?.startsWith("https:")) return null;
  url.protocol = "https:";
  return Response.redirect(url.toString(), 301);
}
