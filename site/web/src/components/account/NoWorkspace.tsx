import { useState } from "react";
import { logout, type Me } from "../../lib/me.ts";

/** 들어갈 워크스페이스가 없을 때(없는 주소·멤버가 아님·아직 초대 전). 관리자(SUPERADMIN)는 여기서 새로 만든다 */
export function NoWorkspace({ me, missing }: { me: Me; missing?: string }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, name }) });
    const body = await res.json() as { slug?: string; error?: string };
    if (!res.ok) return setError(body.error ?? `${res.status} 오류`);
    location.href = `/${body.slug}/`;
  }
  const field = "rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm";
  return (
    <main className="grid min-h-full place-items-center bg-bg p-4">
      <div className="grid w-full max-w-md gap-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-bold">{missing ? `'${missing}' 워크스페이스를 열 수 없습니다` : "들어갈 워크스페이스가 없습니다"}</h1>
        <p className="text-sm text-muted">
          {me.user?.email}로 로그인했습니다. {missing ? "주소가 틀렸거나 이 워크스페이스의 멤버가 아닙니다." : "워크스페이스 관리자에게 초대 링크를 받으세요."}
        </p>
        {me.workspaces.length > 0 && (
          <ul className="grid gap-1 text-sm">
            {me.workspaces.map((w) => <li key={w.slug}><a className="text-accent hover:underline" href={`/${w.slug}/`}>{w.name}</a> <span className="text-xs text-muted">({w.role})</span></li>)}
          </ul>
        )}
        {me.superadmin && (
          <form onSubmit={create} className="grid gap-2 border-t border-line pt-4">
            <p className="text-sm font-bold">새 워크스페이스</p>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 (예: 투모로)" aria-label="워크스페이스 이름" required />
            <input className={`${field} font-mono`} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="주소 (영문, 예: tommoro)" aria-label="워크스페이스 주소" required />
            <button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface">만들기</button>
            {error && <p className="text-xs text-crit">{error}</p>}
          </form>
        )}
        <button className="justify-self-start text-sm text-muted hover:text-fg" onClick={() => void logout()}>로그아웃</button>
      </div>
    </main>
  );
}
