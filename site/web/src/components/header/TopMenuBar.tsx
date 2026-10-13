import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { ChevronLeft, ChevronRight, Ellipsis, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import type { Category } from "../../lib/api.ts";
import { slugify } from "../../lib/files.ts";
import { manage } from "../../lib/manage.ts";
import { useAction } from "../manage/useAction.ts";
import { IconButton } from "../IconButton.tsx";

/**
 * 헤더의 상단 메뉴(대분류) 탭. 탭 줄에서 바로 관리한다.
 * - 탭에 마우스를 올리면 나오는 핸들을 잡아 끌어서 순서 변경. 놓을 탭의 왼쪽·오른쪽 절반에 따라 그쪽에 세로선이 나온다. 키보드는 ⋯ 메뉴의 왼쪽·오른쪽으로
 * - ⋯ 메뉴(선택된 탭): 이름 변경(탭 자리에서 바로 입력, 더블클릭으로도), 이동, 삭제(하위 메뉴가 없을 때만)
 * - ＋: 이름·key를 입력해 추가하고 새 대분류로 이동
 * 탭 줄은 넘치면 가로로 스크롤되므로 ⋯ 메뉴와 ＋ 팝오버는 화면 기준(fixed)으로 띄워 잘리지 않게 한다.
 */

/** 버튼 아래에 화면 기준으로 뜨는 작은 창. 바깥을 누르거나 Esc를 누르면 닫힌다 */
function Floating({ anchor, onClose, children, align = "left" }: {
  anchor: HTMLElement; onClose: () => void; children: ReactNode; align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const r = anchor.getBoundingClientRect();
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [anchor, onClose]);
  const left = align === "left" ? Math.min(r.left, innerWidth - 268) : Math.max(8, r.right - 260);
  return (
    <div ref={ref} role="dialog" className="fixed z-40 w-[260px] rounded-lg border border-line bg-surface p-1.5 shadow-xl"
      style={{ top: r.bottom + 6, left: Math.max(8, left) }}>
      {children}
    </div>
  );
}

const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-sunken disabled:pointer-events-none disabled:opacity-40";

function TabMenu({ cat, index, count, anchor, onClose, onRename }: {
  cat: Category; index: number; count: number; anchor: HTMLElement; onClose: () => void; onRename: () => void;
}) {
  const { category: current } = useParams();
  const navigate = useNavigate();
  const { run, busy, error } = useAction();
  const hasMenus = cat.menus.length > 0;
  const deleteBlock = hasMenus ? `하위 메뉴 ${cat.menus.length}개가 있어 지울 수 없습니다` : count === 1 ? "대분류는 하나 이상 있어야 합니다" : "";

  const move = async (to: number) => { await run(() => manage.updateCategory(cat.key, { index: to })); onClose(); };
  const remove = async () => {
    const ok = await run(() => manage.deleteCategory(cat.key), {
      title: "대분류를 삭제할까요?", tone: "danger", confirmText: "삭제", details: [`대분류: ${cat.name} (${cat.key})`],
      message: "상단 메뉴에서 빠집니다. 하위 메뉴가 없는 대분류만 지울 수 있습니다.",
    });
    if (ok === undefined) return;
    onClose();
    if (current === cat.key) navigate("/");
  };

  return (
    <Floating anchor={anchor} onClose={onClose}>
      <p className="px-2.5 pt-1 pb-1.5 font-mono text-[11px] text-muted">{cat.name} · {cat.key}</p>
      <button className={item} onClick={() => { onClose(); onRename(); }}><Pencil size={16} aria-hidden /> 이름 바꾸기</button>
      <button className={item} disabled={busy || index === 0} onClick={() => move(index - 1)}><ChevronLeft size={16} aria-hidden /> 왼쪽으로</button>
      <button className={item} disabled={busy || index === count - 1} onClick={() => move(index + 1)}><ChevronRight size={16} aria-hidden /> 오른쪽으로</button>
      <div className="my-1 border-t border-line" />
      <button className={`${item} text-crit`} disabled={busy || !!deleteBlock} onClick={remove} data-tip={deleteBlock || undefined}>
        <Trash2 size={16} aria-hidden /> 삭제
      </button>
      {deleteBlock && <p className="px-2.5 pb-1 text-xs text-muted">{deleteBlock}</p>}
      {error && <p className="m-1 rounded bg-crit-soft px-2 py-1 text-xs text-crit">{error}</p>}
    </Floating>
  );
}

function AddPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const navigate = useNavigate();
  const { run, busy, error } = useAction();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const finalKey = key.trim() || slugify(name);
  return (
    <Floating anchor={anchor} onClose={onClose}>
      <form className="grid gap-2 p-1.5" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => manage.addCategory(name, key), {
          title: "대분류를 추가할까요?", confirmText: "추가", details: [`이름: ${name.trim()}`, `key: ${finalKey}`],
        });
        if (r) { onClose(); navigate(`/${r.key}`); }
      }}>
        <p className="text-sm font-bold">대분류 추가</p>
        <input className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm" placeholder="이름 (예: 운영)"
          value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <input className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-sm" placeholder={finalKey || "key (영문, URL에 쓰임)"}
          value={key} onChange={(e) => setKey(e.target.value)} aria-label="key" />
        <p className="text-[11px] text-muted">key는 주소(/{finalKey || "key"})와 문서 정보에 쓰여 나중에 바꿀 수 없습니다.</p>
        {error && <p className="rounded bg-crit-soft px-2 py-1 text-xs text-crit">{error}</p>}
        <button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-50" disabled={busy || !name.trim()}>추가</button>
      </form>
    </Floating>
  );
}

/** 탭 이름을 그 자리에서 고친다. Enter 저장(확인 창), Esc·바깥 클릭 취소 */
function RenameInput({ cat, onDone }: { cat: Category; onDone: () => void }) {
  const { run } = useAction();
  const [name, setName] = useState(cat.name);
  const done = useRef(false);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && name.trim() && name.trim() !== cat.name) {
      await run(() => manage.updateCategory(cat.key, { name }), {
        title: "대분류 이름을 바꿀까요?", confirmText: "저장", details: [`${cat.name} → ${name.trim()}`],
      });
    }
    onDone();
  };
  return (
    <input
      className="my-1.5 w-32 rounded-md border border-accent bg-surface px-2 py-1 text-sm font-medium"
      value={name}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        // 한글 조합 중 Enter(isComposing)는 건너뛴다. 맥 크롬은 조합이 끝난 뒤 Enter keydown을 한 번 더 보내는데,
        // 조합 중 Enter로 확인 창을 열면 그 두 번째 Enter가 확인 창의 "취소"를 눌러 버린다
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        // Enter 기본 동작을 막아야 확인 창의 버튼이 같은 키 입력을 받아 바로 실행되지 않는다
        if (e.key === "Enter") { e.preventDefault(); void finish(true); }
        if (e.key === "Escape") { e.preventDefault(); void finish(false); }
      }}
      onBlur={() => void finish(false)}
      aria-label={`${cat.name} 이름`}
    />
  );
}

export function TopMenuBar({ categories }: { categories: Category[] }) {
  const { category: current } = useParams();
  const { run } = useAction();
  const [menuFor, setMenuFor] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  // 끌어다 놓기: target은 지금 커서가 올라간 탭과 그 탭의 어느 쪽(왼쪽·오른쪽 절반)에 놓을지
  const [drag, setDrag] = useState<{ from: number; target: { index: number; side: "left" | "right" } | null } | null>(null);

  // 놓을 위치(0..n, "몇 번째 탭 앞")와 실제로 자리가 바뀌는지
  const insertAt = (t: { index: number; side: "left" | "right" }) => (t.side === "left" ? t.index : t.index + 1);
  const moves = (from: number, pos: number) => pos !== from && pos !== from + 1;

  const drop = async () => {
    if (!drag?.target) return setDrag(null);
    const from = drag.from;
    const pos = insertAt(drag.target);
    setDrag(null);
    // 서버 index는 자기 자리를 뺀 목록 기준이다
    if (moves(from, pos)) await run(() => manage.updateCategory(categories[from].key, { index: pos > from ? pos - 1 : pos }));
  };

  return (
    <nav
      className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto px-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="대분류"
      onDragOver={(e) => { if (drag) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); void drop(); }}
    >
      {categories.map((c, i) => {
        const active = current === c.key;
        const t = drag?.target;
        const lineSide = drag && t && t.index === i && moves(drag.from, insertAt(t)) ? t.side : null;
        return (
          <div
            key={c.key}
            className={`group relative flex shrink-0 items-center border-b-2 ${active ? "border-accent" : "border-transparent"} ${
              drag?.from === i ? "opacity-40" : lineSide ? "bg-accent-soft/50" : ""
            }`}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const r = e.currentTarget.getBoundingClientRect();
              const side = e.clientX < r.left + r.width / 2 ? "left" : "right";
              if (t?.index !== i || t.side !== side) setDrag({ ...drag, target: { index: i, side } });
            }}
            onDragLeave={(e) => {
              if (drag && !e.currentTarget.contains(e.relatedTarget as Node) && t?.index === i) setDrag({ ...drag, target: null });
            }}
          >
            {/* 놓을 자리 표시선: 커서가 있는 쪽(왼쪽·오른쪽) */}
            {lineSide && (
              <span className={`absolute inset-y-1.5 w-[3px] rounded-full bg-accent ${lineSide === "left" ? "-left-[2px]" : "-right-[2px]"}`} aria-hidden />
            )}
            {/* 드래그 핸들: 마우스를 올리면 보인다. 이 핸들을 잡아야 끌린다(탭 링크는 눌러도 끌리지 않는다) */}
            <span
              draggable={renaming !== c.key}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", c.key);
                const tab = e.currentTarget.parentElement!;
                e.dataTransfer.setDragImage(tab, e.clientX - tab.getBoundingClientRect().left, 16);
                setDrag({ from: i, target: null });
              }}
              onDragEnd={() => setDrag(null)}
              className={`flex cursor-grab items-center self-stretch pl-1 text-muted active:cursor-grabbing ${
                drag?.from === i ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
              data-tip="끌어서 순서 변경 (왼쪽·오른쪽 어디로든 놓을 수 있습니다)"
              aria-label={`${c.name} 순서 변경 핸들`}
              role="img"
            >
              <GripVertical size={14} aria-hidden />
            </span>
            {renaming === c.key ? (
              <RenameInput cat={c} onDone={() => setRenaming(null)} />
            ) : (
              <>
                <NavLink
                  to={`/${c.key}`}
                  draggable={false}
                  onDoubleClick={() => setRenaming(c.key)}
                  className={`py-3 pl-1 text-sm font-medium whitespace-nowrap ${active ? "pr-1 text-fg" : "pr-3 text-muted hover:text-fg"}`}
                  data-tip="더블클릭으로 이름 변경"
                >
                  {c.name}
                </NavLink>
                {/* ⋯ 버튼은 선택된 탭에만 둔다(빈 자리로 탭 간격이 벌어지지 않게). 링크 안에 넣지 않는다(링크 안의 버튼은 HTML 규칙 위반) */}
                {(active || menuFor?.key === c.key) && (
                  <IconButton icon={Ellipsis} label={`${c.name} 메뉴`} size={16} className="mr-1.5 p-0.5"
                    aria-haspopup="menu" aria-expanded={menuFor?.key === c.key}
                    onClick={(e) => setMenuFor(menuFor?.key === c.key ? null : { key: c.key, anchor: e.currentTarget })} />
                )}
              </>
            )}
            {menuFor?.key === c.key && (
              <TabMenu cat={c} index={i} count={categories.length} anchor={menuFor.anchor}
                onClose={() => setMenuFor(null)} onRename={() => setRenaming(c.key)} />
            )}
          </div>
        );
      })}
      <div className="flex shrink-0 items-center pl-1">
        <IconButton icon={Plus} label="대분류 추가" size={18} aria-haspopup="dialog" aria-expanded={!!adding}
          onClick={(e) => setAdding(adding ? null : e.currentTarget)} />
      </div>
      {adding && <AddPopover anchor={adding} onClose={() => setAdding(null)} />}
    </nav>
  );
}
