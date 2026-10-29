import { useState } from "react";
import { Copy, Link2, Trash2, UserMinus } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "../../lib/base.ts";
import { useMe, type Role } from "../../lib/me.ts";
import { copyText } from "../../lib/seg.ts";
import { IconButton } from "../IconButton.tsx";
import { Modal, ui } from "../Modal.tsx";
import { useConfirm } from "../confirm/ConfirmProvider.tsx";

interface Member { id: number; email: string; name: string | null; role: Role; joinedAt: string }
interface Invite { id: string; role: Role; email: string | null; createdAt: string; expiresAt: string; createdBy: string | null }

const ROLE_LABEL: Record<Role, string> = { owner: "관리자(owner)", editor: "편집자(editor)", viewer: "보기만(viewer)" };

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} 오류`);
  return json;
}

/** 멤버 목록·역할 바꾸기·내보내기와 초대 링크(owner만 고친다). 4.0 P4 */
export function MembersDialog({ onClose }: { onClose: () => void }) {
  const { me, role } = useMe();
  const owner = role === "owner";
  const qc = useQueryClient();
  const confirm = useConfirm();
  const members = useQuery({ queryKey: ["members"], queryFn: async () => (await fetch(`${API}/members`)).json() as Promise<Member[]> });
  const invites = useQuery({ queryKey: ["invites"], enabled: owner, queryFn: async () => (await fetch(`${API}/invites`)).json() as Promise<Invite[]> });
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [inviteEmail, setInviteEmail] = useState("");
  const [created, setCreated] = useState<{ url: string; copied: boolean } | null>(null);
  const [error, setError] = useState("");

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); }
    void qc.invalidateQueries({ queryKey: ["members"] });
    void qc.invalidateQueries({ queryKey: ["invites"] });
  };

  return (
    <Modal title={owner ? "멤버·초대 관리" : "멤버"} onClose={onClose} wide>
      <ul className="grid max-h-[40dvh] gap-1.5 overflow-y-auto" aria-label="멤버 목록">
        {members.data?.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{m.name ? `${m.name} · ` : ""}<span className="text-muted">{m.email}</span>{m.id === me?.user?.id ? " (나)" : ""}</span>
            {owner ? (
              <select className={`${ui.field} w-auto text-xs`} value={m.role} aria-label={`${m.email} 역할`}
                onChange={async (e) => {
                  const next = e.target.value as Role;
                  if (await confirm({ title: "역할을 바꿀까요?", confirmText: "바꾸기", details: [`${m.email}: ${ROLE_LABEL[m.role]} → ${ROLE_LABEL[next]}`] })) {
                    await act(() => send("PATCH", `/members/${m.id}`, { role: next }));
                  }
                }}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            ) : <span className="text-xs text-muted">{ROLE_LABEL[m.role]}</span>}
            {owner && (
              <IconButton icon={UserMinus} label={`${m.email} 내보내기`} onClick={async () => {
                if (await confirm({ title: "워크스페이스에서 내보낼까요?", tone: "danger", confirmText: "내보내기", details: [m.email] })) {
                  await act(() => send("DELETE", `/members/${m.id}`));
                }
              }} />
            )}
          </li>
        ))}
      </ul>

      {owner && (
        <section className="grid gap-2 border-t border-line pt-4">
          <h3 className="text-sm font-bold">초대 링크</h3>
          <p className="text-xs text-muted">링크를 만들어 직접 전달하세요. 7일 동안 한 번 쓸 수 있습니다. 이메일을 넣으면 그 Google 계정만 받을 수 있습니다.</p>
          <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
            e.preventDefault();
            await act(async () => {
              const r = await send("POST", "/invites", { role: inviteRole, email: inviteEmail || undefined }) as { url: string };
              setCreated({ url: r.url, copied: await copyText(r.url) });
              setInviteEmail("");
            });
          }}>
            <select className={`${ui.field} w-auto`} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="초대 역할">
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <input className={`${ui.field} min-w-48 flex-1`} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="이메일(선택)" aria-label="초대 이메일" />
            <IconButton type="submit" icon={Link2} label="초대 링크 만들기" text="초대 링크 만들기" variant="primary" />
          </form>
          {created && (
            <div className="flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-xs">
              <code className="min-w-0 flex-1 break-all" aria-label="만든 초대 링크">{created.url}</code>
              <IconButton icon={Copy} label="복사" text={created.copied ? "복사됨" : "복사"} variant="outline"
                onClick={async () => setCreated({ ...created, copied: await copyText(created.url) })} />
            </div>
          )}
          {!!invites.data?.length && (
            <ul className="grid gap-1 text-xs" aria-label="대기 중인 초대">
              {invites.data.map((i) => (
                <li key={i.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5">
                  <span className="flex-1">{ROLE_LABEL[i.role]}{i.email ? ` · ${i.email}` : " · 누구나"} <span className="text-muted">· {i.expiresAt.slice(0, 10)}까지</span></span>
                  <IconButton icon={Trash2} label="초대 취소" onClick={() => void act(() => send("DELETE", `/invites/${i.id}`))} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {error && <p className={ui.error}>{error}</p>}
    </Modal>
  );
}
