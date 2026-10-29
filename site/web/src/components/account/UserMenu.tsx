import { useState } from "react";
import { LogOut, Users } from "lucide-react";
import { WS } from "../../lib/base.ts";
import { logout, useMe } from "../../lib/me.ts";
import { ContextMenu, type MenuEntry } from "../sidebar/ContextMenu.tsx";
import { MembersDialog } from "./MembersDialog.tsx";

/** 헤더 오른쪽 계정 메뉴(Cloudflare): 워크스페이스 바꾸기, 멤버·초대, 로그아웃 */
export function UserMenu() {
  const { me, role } = useMe();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [members, setMembers] = useState(false);
  if (!me?.user) return null;
  const items: MenuEntry[] = [
    ...me.workspaces.filter((w) => w.slug !== WS).map((w) => ({ label: `${w.name}(으)로 이동`, icon: Users, onSelect: () => { location.href = `/${w.slug}/`; } })),
    ...(me.workspaces.length > 1 ? ["separator" as const] : []),
    { label: role === "owner" ? "멤버·초대 관리" : "멤버 보기", icon: Users, onSelect: () => setMembers(true) },
    { label: "로그아웃", icon: LogOut, onSelect: () => void logout() },
  ];
  const ws = me.workspaces.find((w) => w.slug === WS);
  return (
    <>
      <button type="button" aria-label="계정 메뉴" data-tip={`${me.user.email} · ${ws?.name ?? ""}(${role})`}
        className="ml-1 grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-sunken text-sm font-bold text-muted hover:border-accent"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 200, y: r.bottom + 6 }); }}>
        {me.user.picture ? <img src={me.user.picture} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : (me.user.name ?? me.user.email)[0].toUpperCase()}
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} label="계정 메뉴" items={items} onClose={() => setMenu(null)} />}
      {members && <MembersDialog onClose={() => setMembers(false)} />}
    </>
  );
}
