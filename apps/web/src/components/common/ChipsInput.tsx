import { useState } from "react";
import { X } from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Several e-mails (or phone numbers) in one field: each becomes a chip on Enter, comma, semicolon or when leaving the
 * field; pasting a list splits it. Invalid ones are refused with a message under the field.
 */
export function ChipsInput({
  value,
  onChange,
  placeholder,
  kind = "email",
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  kind?: "email" | "phone";
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function valid(item: string): boolean {
    return kind === "email" ? EMAIL_RE.test(item) : item.replace(/\D/g, "").length >= 10;
  }

  function commit(raw: string) {
    const items = raw
      .split(/[,;\s]+/)
      .map((s) => (kind === "email" ? s.trim().toLowerCase() : s.trim()))
      .filter(Boolean);
    if (items.length === 0) return;
    const bad = items.filter((i) => !valid(i));
    const good = items.filter((i) => valid(i) && !value.includes(i));
    if (good.length) onChange([...value, ...good]);
    setError(bad.length ? `${kind === "email" ? "E-mail inválido" : "Número inválido (use DDD + número)"}: ${bad.join(", ")}` : null);
    setDraft(bad.join(" "));
  }

  return (
    <div>
      <div className="focus-within:ring-2 focus-within:ring-primary/40 flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-card border border-border px-2 py-1.5">
        {value.map((item) => (
          <span key={item} className="flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary">
            {item}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((v) => v !== item))} className="rounded-full p-0.5 hover:bg-primary/20" aria-label={`Remover ${item}`}>
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        <input
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (["Enter", ",", ";"].includes(e.key)) {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => commit(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[,;\s]/.test(text.trim())) {
              e.preventDefault();
              commit(`${draft} ${text}`);
            }
          }}
          placeholder={value.length ? "" : placeholder}
          inputMode={kind === "email" ? "email" : "tel"}
          className="min-w-[140px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
