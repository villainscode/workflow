import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm, type ConfirmOptions } from "../confirm/ConfirmProvider.tsx";

/**
 * 관리 작업 실행: (confirm을 주면) 공통 확인 창 → 진행 중 표시 → 오류 메시지 → 목록·문서·휴지통 새로고침.
 * 확인 창에서 취소하면 아무것도 하지 않고 undefined를 돌려준다.
 */
export function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = useConfirm();
  async function run<T>(fn: () => Promise<T>, confirmWith?: ConfirmOptions): Promise<T | undefined> {
    if (confirmWith && !(await confirm(confirmWith))) return undefined;
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      // 새로고침은 기다리지 않는다. 문서를 옮기면 옛 주소 조회가 404가 되는데, 그걸 기다리면 이동이 늦어진다
      for (const k of ["tree", "doc", "trash", "search"]) void qc.invalidateQueries({ queryKey: [k] });
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error };
}
