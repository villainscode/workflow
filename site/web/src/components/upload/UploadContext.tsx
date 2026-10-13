import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { UploadFile } from "../../lib/api.ts";
import { UploadDialog } from "./UploadDialog.tsx";

/** 업로드 대화상자를 여는 위치에 따라 미리 채울 값 */
export interface UploadPreset {
  category?: string;
  menu?: string;     // 메뉴별 + 버튼, 메뉴에 끌어다 놓기
  doc?: string;      // 문서 화면의 "새 버전"
  parent?: string;   // 사이드바 문서 메뉴의 "하위 문서 추가": 새 문서를 이 문서 아래에
  files?: UploadFile[];
}

const Ctx = createContext<(preset: UploadPreset) => void>(() => {});
export const useOpenUpload = () => useContext(Ctx);

export function UploadProvider({ children }: { children: ReactNode }) {
  const [preset, setPreset] = useState<UploadPreset | null>(null);
  const [nonce, setNonce] = useState(0);
  const open = useCallback((p: UploadPreset) => { setPreset(p); setNonce((n) => n + 1); }, []);
  return (
    <Ctx.Provider value={open}>
      {children}
      {preset && <UploadDialog key={nonce} preset={preset} onClose={() => setPreset(null)} />}
    </Ctx.Provider>
  );
}
