/** Puts `tag` where the cursor is in the textarea (or at the end) and keeps typing after it. */
export function insertTag(textarea: HTMLTextAreaElement | null, text: string, tag: string, setText: (next: string) => void) {
  const start = textarea?.selectionStart ?? text.length;
  const end = textarea?.selectionEnd ?? text.length;
  setText(text.slice(0, start) + tag + text.slice(end));
  requestAnimationFrame(() => {
    textarea?.focus();
    textarea?.setSelectionRange(start + tag.length, start + tag.length);
  });
}

/** "Clique para inserir:" and one chip per tag. */
export function TagButtons({ tags, onInsert }: { tags: readonly string[]; onInsert: (tag: string) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
      Clique para inserir:
      {tags.map((tag) => (
        <button key={tag} type="button" onClick={() => onInsert(tag)} className="focus-ring rounded bg-primary/10 px-1.5 py-0.5 font-mono text-primary hover:bg-primary/20">
          {tag}
        </button>
      ))}
    </div>
  );
}
