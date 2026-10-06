import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** 서버의 변경 알림(SSE)을 받으면 목록과 문서 정보를 다시 불러온다. */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["doc"] });
    };
    return () => es.close();
  }, [qc]);
}
