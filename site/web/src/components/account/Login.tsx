import { useState } from "react";

/** 로그인 화면(Cloudflare). Google 로그인만 쓴다(초대받은 사람만). devLogin이면 개발용 이메일 로그인 칸을 함께 보여 준다 */
export function Login({ devLogin }: { devLogin?: boolean }) {
  const next = location.pathname + location.search;
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  async function dev(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/auth/dev-login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, next }), redirect: "follow",
    });
    if (res.redirected || res.ok) location.href = res.redirected ? res.url : next;
    else setError((await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }
  return (
    <main className="grid min-h-full place-items-center bg-bg p-4">
      <div className="grid w-full max-w-sm gap-5 rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
        <img src="/logo.svg" alt="" className="mx-auto h-8 w-auto" />
        <div className="grid gap-1">
          <h1 className="text-xl font-bold">문서 탐색 워크플로우</h1>
          <p className="text-sm text-muted">초대받은 Google 계정으로 로그인하세요.</p>
        </div>
        <a href={`/api/auth/google?next=${encodeURIComponent(next)}`}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium hover:bg-sunken">
          <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>
          Google로 로그인
        </a>
        {devLogin && (
          <form onSubmit={dev} className="grid gap-2 border-t border-line pt-4 text-left">
            <label className="grid gap-1 text-xs font-medium text-muted">개발용 로그인(로컬 전용)
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-label="개발용 이메일"
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm" placeholder="dev@example.com" />
            </label>
            <button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface">개발용 로그인</button>
            {error && <p className="text-xs text-crit">{error}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
