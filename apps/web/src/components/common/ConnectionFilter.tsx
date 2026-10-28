import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Radio } from "lucide-react";
import { api } from "../../lib/api";

interface ConnectionOption {
  id: string;
  name: string;
}

/** Multi-select "Conexão WhatsApp" filter — empty selection means "todas". Used by Gestão, Dashboard and Relatórios. */
export function ConnectionFilter({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<ConnectionOption[]>("/whatsapp/connections")).data,
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  const label =
    value.length === 0
      ? "Todas as conexões"
      : value.length === 1
        ? (connections?.find((c) => c.id === value[0])?.name ?? "1 conexão")
        : `${value.length} conexões`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm"
      >
        <Radio className="h-4 w-4 text-primary" />
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-muted" />
      </button>

      {open && (
        <div className="shadow-soft absolute left-0 top-full z-20 mt-1 w-56 rounded-card border border-border bg-surface p-2">
          <button
            type="button"
            onClick={() => onChange([])}
            className={`focus-ring flex w-full items-center rounded-card px-2 py-1.5 text-left text-sm hover:bg-surface-alt ${value.length === 0 ? "font-semibold text-primary" : ""}`}
          >
            Todas as conexões
          </button>
          <div className="my-1 border-t border-border" />
          {connections?.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-card px-2 py-1.5 text-sm hover:bg-surface-alt">
              <input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} />
              {c.name}
            </label>
          ))}
          {connections?.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">Nenhuma conexão cadastrada.</p>}
        </div>
      )}
    </div>
  );
}
