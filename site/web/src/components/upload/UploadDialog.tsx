import { useEffect, useMemo, useRef, useState } from "react";
import { File as FileIcon, FilePlus2, Folder, Upload, X } from "lucide-react";
import { IconButton } from "../IconButton.tsx";
import { useConfirm } from "../confirm/ConfirmProvider.tsx";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  createMenu, nextVersion, versionLabel, uploadFiles, useDoc, useTree, type MenuNode, type UploadFile,
} from "../../lib/api.ts";
import { commonRoot, filesFromDrop, filesFromInput, formatSize, guessEntry, slugify } from "../../lib/files.ts";
import { flattenDocs } from "../../lib/docTree.ts";
import { stopComposingEnter } from "../../lib/ime.ts";
import type { UploadPreset } from "./UploadContext.tsx";

const NEW_MENU = "__new__";
const field = "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm";
const label = "grid gap-1 text-xs font-medium text-muted";

function flatten(menus: MenuNode[], depth = 0): { menu: MenuNode; depth: number }[] {
  return menus.flatMap((m) => [{ menu: m, depth }, ...flatten(m.menus, depth + 1)]);
}

export function UploadDialog({ preset, onClose }: { preset: UploadPreset; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: tree } = useTree();
  const confirm = useConfirm();

  const [category, setCategory] = useState(preset.category ?? "sdlc");
  const [menu, setMenu] = useState(preset.menu ?? "");
  const [newMenuName, setNewMenuName] = useState("");
  const [newMenuSlug, setNewMenuSlug] = useState("");
  const [mode, setMode] = useState<"new" | "existing">(preset.doc ? "existing" : "new");
  // files: 파일 올리기, markdown: 빈 Markdown 문서를 만들어 바로 편집
  const [kind, setKind] = useState<"files" | "markdown">("files");
  const [doc, setDoc] = useState(preset.doc ?? "");
  const [parent, setParent] = useState(preset.parent ?? "");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [version, setVersion] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<UploadFile[]>(preset.files ?? []);
  const [entry, setEntry] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); }, []);

  // 미리 지정한 메뉴가 있으면 그 메뉴의 대분류로 맞춘다
  const cat = tree?.categories.find((c) => c.key === category);
  useEffect(() => {
    if (!tree || !preset.menu) return;
    const owner = tree.categories.find((c) => flatten(c.menus).some((x) => x.menu.slug === preset.menu));
    if (owner) setCategory(owner.key);
  }, [tree, preset.menu]);
  const menuOptions = useMemo(() => flatten(cat?.menus ?? []), [cat]);
  useEffect(() => {
    if (!menu && cat) setMenu(menuOptions[0]?.menu.slug ?? NEW_MENU);
  }, [cat, menu, menuOptions]);

  const menuDocs = menuOptions.find((x) => x.menu.slug === menu)?.menu.documents ?? [];
  const existingDoc = useDoc(menu, doc);
  const suggested = mode === "existing" && existingDoc.data ? nextVersion(existingDoc.data.versions.map((v) => v.version)) : "v0.0";

  const root = commonRoot(files);
  const relPaths = files.map((f) => f.path.slice(root.length));
  const autoEntry = guessEntry(files);
  const zipOnly = files.length === 1 && /\.zip$/i.test(files[0].path);
  const autoSlug = slugify(autoEntry.split("/").pop() ?? "") || "doc";

  const addFiles = (more: UploadFile[]) => setFiles((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.path === m.path))]);

  async function submit() {
    setError("");
    const isMd = kind === "markdown";
    if (!isMd && files.length === 0) return setError("올릴 파일을 추가하세요");
    if (mode === "new" && !title.trim()) return setError("제목을 입력하세요");
    if (mode === "existing" && !doc) return setError("새 버전을 올릴 문서를 고르세요");
    const menuName = menu === NEW_MENU ? `${newMenuName.trim()} (새 메뉴)` : menuOptions.find((x) => x.menu.slug === menu)?.menu.name ?? menu;
    const docName = mode === "existing" ? menuDocs.find((d) => d.slug === doc)?.title ?? doc : `${title.trim()} (새 문서)`;
    const parentName = mode === "new" && parent ? menuDocs.find((d) => d.slug === parent)?.title ?? parent : "";
    const ok = await confirm({
      title: isMd ? "새 Markdown 문서를 만들까요?" : mode === "existing" ? "새 버전을 올릴까요?" : "문서를 업로드할까요?",
      confirmText: isMd ? "만들기" : "업로드",
      details: [
        `메뉴: ${menuName}`, ...(parentName ? [`상위 문서: ${parentName}`] : []), `문서: ${docName}`, `버전: ${versionLabel(version || suggested)}`,
        ...(isMd ? [] : [`파일: ${files.length}개${files.length > 1 ? ` (대표 파일 ${entry || autoEntry})` : ` (${relPaths[0]})`}`]),
      ],
    });
    if (!ok) return;
    setBusy(true);
    try {
      let menuSlug = menu;
      if (menu === NEW_MENU) {
        if (!newMenuName.trim()) throw new Error("새 메뉴 이름을 입력하세요");
        menuSlug = (await createMenu(category, newMenuName, newMenuSlug || undefined)).slug;
      }
      const mdName = `${slug || slugify(title) || "doc"}.md`;
      const result = await uploadFiles(isMd
        ? {
          menu: menuSlug, parent: parent || undefined, title, slug: slug || undefined, version: version || undefined, note: note || "새 문서",
          files: [{ file: new File([`# ${title.trim()}\n\n`], mdName, { type: "text/markdown" }), path: mdName }],
        }
        : {
          menu: menuSlug,
          doc: mode === "existing" ? doc : undefined,
          parent: mode === "new" && parent ? parent : undefined,
          title: mode === "new" ? title : undefined,
          slug: mode === "new" ? slug || undefined : undefined,
          version: version || undefined,
          note,
          entry: zipOnly ? undefined : entry || undefined,
          files,
        });
      await qc.invalidateQueries({ queryKey: ["tree"] });
      await qc.invalidateQueries({ queryKey: ["doc", result.menu, result.doc] });
      onClose();
      // 새 Markdown 문서는 편집 창을 열고 커서를 둔다(MarkdownViewer)
      navigate(`/${result.category}/${result.menu}/${result.doc}`, isMd ? { state: { edit: true } } : undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(640px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] rounded-xl border border-line bg-surface p-0 text-fg backdrop:bg-black/40"
    >
      <form method="dialog" className="grid gap-4 p-5" onKeyDown={stopComposingEnter} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">
            {mode === "existing" ? "새 버전 올리기" : kind === "markdown" ? "새 Markdown 문서" : "문서 업로드"}
          </h2>
          <IconButton icon={X} label="닫기" size={22} onClick={onClose} />
        </div>

        {!preset.doc && (
          <div className="flex gap-1 rounded-lg bg-sunken p-1 text-sm">
            {(["files", "markdown"] as const).map((k) => (
              <button key={k} type="button"
                className={`flex-1 rounded-md px-3 py-1.5 ${kind === k ? "bg-surface font-medium shadow-sm" : "text-muted"}`}
                onClick={() => { setKind(k); if (k === "markdown") setMode("new"); }}>
                {k === "files" ? "파일 업로드" : "새 Markdown 문서"}
              </button>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>대분류
            <select className={field} value={category} disabled={!!preset.menu || !!preset.doc}
              onChange={(e) => { setCategory(e.target.value); setMenu(""); setDoc(""); }}>
              {tree?.categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
            </select>
          </label>
          <label className={label}>메뉴
            <select className={field} value={menu} disabled={!!preset.menu || !!preset.doc}
              onChange={(e) => { setMenu(e.target.value); setDoc(""); setParent(""); if (e.target.value === NEW_MENU) setMode("new"); }}>
              {menuOptions.map(({ menu: m, depth }) => (
                <option key={m.slug} value={m.slug}>{"  ".repeat(depth) + m.name}</option>
              ))}
              <option value={NEW_MENU}>＋ 새 메뉴 만들기</option>
            </select>
          </label>
          {menu === NEW_MENU && (
            <>
              <label className={label}>새 메뉴 이름
                <input className={field} value={newMenuName} onChange={(e) => setNewMenuName(e.target.value)} placeholder="예: 빌드·배포" />
              </label>
              <label className={label}>메뉴 slug (영문)
                <input className={field} value={newMenuSlug} onChange={(e) => setNewMenuSlug(e.target.value)}
                  placeholder={slugify(newMenuName) || "build-deploy"} />
              </label>
            </>
          )}
        </div>

        {menu !== NEW_MENU && kind === "files" && (
          <fieldset className="flex gap-4 text-sm" disabled={!!preset.doc || !!preset.parent}>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> 새 문서
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === "existing"} disabled={menuDocs.length === 0}
                onChange={() => { setMode("existing"); setDoc(menuDocs[0]?.slug ?? ""); }} /> 기존 문서에 새 버전
            </label>
          </fieldset>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {mode === "new" ? (
            <>
              <label className={`${label} sm:col-span-2`}>제목
                <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 로그인 시퀀스 다이어그램" />
              </label>
              {menu !== NEW_MENU && menuDocs.length > 0 && (
                <label className={`${label} sm:col-span-2`}>위치
                  <select className={field} value={parent} disabled={!!preset.parent} onChange={(e) => setParent(e.target.value)}>
                    <option value="">메뉴 바로 아래</option>
                    {flattenDocs(menuDocs).map(({ doc: d, depth }) => <option key={d.slug} value={d.slug}>{"　".repeat(depth)}{d.title} 아래 (하위 문서)</option>)}
                  </select>
                </label>
              )}
              <label className={label}>문서 slug (영문, 폴더 이름)
                <input className={field} value={slug} onChange={(e) => setSlug(e.target.value)}
                  placeholder={kind === "markdown" ? slugify(title) || "doc" : autoSlug} />
              </label>
            </>
          ) : (
            <label className={label}>문서
              <select className={field} value={doc} disabled={!!preset.doc} onChange={(e) => setDoc(e.target.value)}>
                {flattenDocs(menuDocs).map(({ doc: d, depth }) => <option key={d.slug} value={d.slug}>{"　".repeat(depth)}{d.title} ({versionLabel(d.currentVersion)})</option>)}
              </select>
            </label>
          )}
          <label className={label}>버전
            <input className={`${field} font-mono`} value={version} onChange={(e) => setVersion(e.target.value)} placeholder={suggested === "v0.0" ? "v0.0 (draft)" : suggested} />
          </label>
          <label className={`${label} sm:col-span-2`}>변경 메모
            <input className={field} value={note} onChange={(e) => setNote(e.target.value)} placeholder="무엇을 왜 바꿨는지 한 줄로" />
          </label>
        </div>

        {kind === "files" && (<>
        <div
          className={`grid gap-2 rounded-lg border-2 border-dashed p-4 text-center text-sm ${dragging ? "border-accent bg-accent-soft" : "border-line"}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={async (e) => { e.preventDefault(); setDragging(false); addFiles(await filesFromDrop(e.dataTransfer)); }}
        >
          <p className="text-muted">파일이나 폴더를 여기에 끌어다 놓으세요. zip 파일은 풀어서 올립니다.</p>
          <div className="flex justify-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 py-1 hover:bg-sunken">
              <FileIcon size={18} aria-hidden /> 파일 선택<input type="file" multiple hidden onChange={(e) => addFiles(filesFromInput(e.target.files))} />
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 py-1 hover:bg-sunken">
              <Folder size={18} aria-hidden /> 폴더 선택<input ref={folderInput} type="file" multiple hidden onChange={(e) => addFiles(filesFromInput(e.target.files))} />
            </label>
          </div>
        </div>

        {files.length > 0 && (
          <div className="grid gap-2">
            <ul className="max-h-40 overflow-y-auto rounded-md border border-line text-xs">
              {files.map((f, i) => (
                <li key={f.path} className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0">
                  <span className="min-w-0 flex-1 font-mono break-all">{relPaths[i]}</span>
                  <span className="text-muted">{formatSize(f.file.size)}</span>
                  <IconButton icon={X} label="목록에서 빼기" size={17} className="p-0.5"
                    onClick={() => setFiles((cur) => cur.filter((x) => x.path !== f.path))} />
                </li>
              ))}
            </ul>
            {files.length > 1 && (
              <label className={label}>대표 파일 (사이트에서 열리는 파일)
                <select className={`${field} font-mono`} value={entry || autoEntry} onChange={(e) => setEntry(e.target.value)}>
                  {relPaths.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        </>)}

        {error && <p className="rounded-md bg-high-soft px-3 py-2 text-sm text-high">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md border border-line px-4 py-1.5 text-sm hover:bg-sunken" onClick={onClose}>취소</button>
          <button type="submit" disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-surface disabled:opacity-50">
            {kind === "markdown" ? <FilePlus2 size={19} aria-hidden /> : <Upload size={19} aria-hidden />}
            {busy ? "만드는 중…" : kind === "markdown" ? "만들고 편집하기" : "업로드"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
