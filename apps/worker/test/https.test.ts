import { describe, expect, it } from "vitest";
import { toHttps } from "../src/https.ts";

/** http로 들어온 요청을 https로 보낸다(2026-11-02 버그: http로 열면 Google 로그인이 redirect_uri_mismatch) */

describe("https로 보내기", () => {
  it("TC-CF-49 APP_ORIGIN이 https면 http 요청은 같은 주소의 https로 301, 로컬(http)·https 요청은 그대로", () => {
    const prod = { APP_ORIGIN: "https://workflow.simplite.net" };
    const r = toHttps(new Request("http://workflow.simplite.net/api/auth/google?next=%2Fteam"), prod)!;
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://workflow.simplite.net/api/auth/google?next=%2Fteam");
    // 콘텐츠 도메인도 같은 호스트의 https로
    expect(toHttps(new Request("http://content.simplite.net/c/tok/a.html"), prod)!.headers.get("location")).toBe("https://content.simplite.net/c/tok/a.html");
    expect(toHttps(new Request("https://workflow.simplite.net/api/me"), prod)).toBeNull();
    expect(toHttps(new Request("http://127.0.0.1:8787/api/me"), { APP_ORIGIN: "http://127.0.0.1:8787" })).toBeNull();
  });
});
