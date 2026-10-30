---
paths:
  - "site/web/**"
---

# 사이트 화면(site/web) 규칙

로컬 사이트와 Cloudflare 앱이 같은 화면 코드를 쓴다. 기능별 설명은 `.claude/guides/site-local.md`.

- **확인 창** (`components/confirm/ConfirmProvider.tsx`, `useConfirm()`): 저장·수정·삭제·다운로드·업로드·이동·복원·휴지통 이동은 공통 확인 창을 거쳐 실행한다. 브라우저 `confirm()`은 쓰지 않는다.
  - 관리 작업은 `useAction().run(작업, 확인옵션)`으로 넘기면 확인 후 실행된다. 무엇이 바뀌는지는 `details`에 적는다.
  - tone은 일반(`default`, 파랑), 이동(`warning`, 주황), 삭제·휴지통(`danger`, 빨강 `--crit`)이다. danger는 기본 포커스가 "취소"다. 버튼 포커스는 창이 열리고 60ms 뒤에 주고, 그 전에는 창 자체에 포커스를 두며 Enter·Space를 버린다. 창을 연 Enter나 맥 한글 입력기가 이어 보내는 두 번째 Enter가 버튼(특히 `showModal`이 바로 포커스하는 "취소")을 눌러 버리는 것을 막기 위해서다(TC-UI-33·34). Enter로 확인 창을 여는 입력칸은 Enter의 기본 동작도 막고, 폼은 `lib/ime.ts`의 `stopComposingEnter`로 한글 조합 중 Enter 제출을 막는다.
  - 순서 변경(↑↓)과 보기 전환은 확인하지 않는다.
  - 구조 편집(5.0, `viewers/structedit/`)은 연산 하나가 곧 수정본 하나(자동 저장)이고 되돌리기로 복구되므로, 넣기·너비·글자·그림 바꾸기·옮기기는 확인 없이 바로 저장한다. 지우기(블록·표·행·열, danger), 예전 수정본으로 되돌리기(warning), 버전으로 저장(default)만 확인 창을 거친다.
- 상태를 바꾸는 버튼은 역할을 확인한다: Cloudflare에서는 `lib/me.ts`의 `useCan()`(edit·own)으로 viewer에게 편집 버튼을 숨긴다. 실제 권한 검사는 서버가 한다.
- API 주소는 `lib/base.ts`의 `API`를, 화면 주소는 라우터 경로(basename이 워크스페이스)를 쓴다. `/api/…`를 직접 적지 않는다.
- **아이콘**: 사이트의 기능 버튼은 Lucide(`lucide-react`) 아이콘으로 만들고 `components/IconButton.tsx`를 쓴다. 아이콘만 있는 버튼은 `label`이 aria-label과 툴팁이 된다. **툴팁은 브라우저 `title`이 아니라 공통 툴팁(`components/Tooltip.tsx`)을 쓴다**: 요소에 `data-tip="설명"`(세로 손잡이처럼 오른쪽에 띄울 때는 `data-tip-side="right"`)을 붙이면, `main.tsx`에 한 번 둔 `TooltipLayer`가 마우스를 올리거나 키보드로 포커스할 때 띄운다. Popover API로 최상위 층에 띄우므로 `showModal` 대화상자와 전체 화면 위에서도 보인다. 툴팁이 있는 요소 안에 또 툴팁을 두지 않는다(안쪽이 이긴다. 예: 상태 배지 버튼 안 `StatusBadge noTip`). 대화상자의 확인·취소처럼 실수하면 안 되는 버튼과 휴지통의 복원·영구 삭제는 아이콘과 글자를 함께 둔다(`text` prop). 유니코드 기호(✕ ☰ ▾ 등)를 아이콘으로 쓰지 않는다.
