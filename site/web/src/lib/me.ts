import { createContext, useContext } from "react";
import { CLOUD } from "./base.ts";

/**
 * 로그인한 사람과 지금 워크스페이스에서의 역할(4.0 P4). 로컬 사이트는 로그인이 없어 늘 owner로 본다.
 * 화면은 역할에 맞지 않는 버튼을 숨길 뿐이고, 실제 권한 검사는 서버(Worker)가 한다.
 */
export type Role = "owner" | "editor" | "viewer";
export interface Me {
  user: { id: number; email: string; name: string | null; picture: string | null } | null;
  workspaces: { slug: string; name: string; role: Role }[];
  superadmin: boolean;
  devLogin?: boolean;
}

export async function loadMe(): Promise<Me> {
  return (await fetch("/api/me")).json() as Promise<Me>;
}

export const MeContext = createContext<{ me: Me | null; role: Role }>({ me: null, role: "owner" });

/** 할 수 있는 일: edit(올리기·고치기·옮기기·휴지통), own(영구 삭제·폴더 삭제·대분류·멤버·초대) */
export function useCan() {
  const { role } = useContext(MeContext);
  return { edit: role !== "viewer", own: role === "owner" };
}

export const useMe = () => useContext(MeContext);

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  location.href = "/";
}

export { CLOUD };
