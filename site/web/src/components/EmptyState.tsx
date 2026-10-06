export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="grid h-full place-content-center gap-2 p-8 text-center">
      <p className="text-lg font-bold">{title}</p>
      {body && <p className="max-w-md text-sm text-muted">{body}</p>}
    </div>
  );
}
