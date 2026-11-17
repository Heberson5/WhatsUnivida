import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Palette } from "lucide-react";
import { toast } from "sonner";
import { MONTH_THEMES } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useBranding } from "../../hooks/useBranding";

/**
 * Identidade visual › Tema: the company's own colors, one of the twelve ready-made themes (one per month), or
 * "Automático pelo mês", which changes by itself on the 1st. The "lida" tick follows the theme — unless a color
 * was picked for it by hand, below, which always wins. Saved on click; everybody sees it at once.
 */
export function ThemePicker({ disabled = false }: { disabled?: boolean }) {
  const { data: branding } = useBranding();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (theme: string) => api.patch("/settings/branding", { theme }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Tema atualizado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const current = branding?.theme ?? "CUSTOM";
  const option = (key: string, selected: boolean) =>
    `focus-ring relative flex items-center gap-2 rounded-card border px-2.5 py-2 text-left text-xs ${selected ? "border-primary ring-1 ring-primary" : "border-border hover:bg-surface-alt"} disabled:cursor-not-allowed disabled:opacity-60`;
  return (
    <div>
      <p className="mb-1 text-sm font-medium">Tema</p>
      <p className="mb-2 text-xs text-muted">
        {branding?.effective.themeName ? `Em uso agora: ${branding.effective.themeName}.` : "Em uso agora: as cores da empresa."} A cor do “lida” (✓✓) acompanha o tema, a menos que você escolha uma cor para ele abaixo. Com um tema, as paletas abaixo valem quando voltar para “Cores da empresa”.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" className={option("CUSTOM", current === "CUSTOM")} disabled={disabled || save.isPending} onClick={() => save.mutate("CUSTOM")} aria-pressed={current === "CUSTOM"}>
          <Palette className="h-4 w-4 shrink-0" />
          <span className="font-medium">Cores da empresa</span>
          {current === "CUSTOM" && <Check className="ms-auto h-4 w-4 text-primary" />}
        </button>
        <button type="button" className={option("MONTHLY", current === "MONTHLY")} disabled={disabled || save.isPending} onClick={() => save.mutate("MONTHLY")} aria-pressed={current === "MONTHLY"}>
          <CalendarClock className="h-4 w-4 shrink-0" />
          <span className="font-medium">Automático pelo mês</span>
          {current === "MONTHLY" && <Check className="ms-auto h-4 w-4 text-primary" />}
        </button>
        {MONTH_THEMES.map((theme) => (
          <button key={theme.key} type="button" className={option(theme.key, current === theme.key)} disabled={disabled || save.isPending} onClick={() => save.mutate(theme.key)} aria-pressed={current === theme.key}>
            <span className="flex shrink-0 overflow-hidden rounded-full border border-border" aria-hidden>
              <span className="h-4 w-3" style={{ background: theme.primaryColor }} />
              <span className="h-4 w-3" style={{ background: theme.secondaryColor }} />
              <span className="h-4 w-3" style={{ background: theme.readReceiptColor }} />
            </span>
            <span className="font-medium">{theme.name}</span>
            {current === theme.key && <Check className="ms-auto h-4 w-4 text-primary" />}
          </button>
        ))}
      </div>
    </div>
  );
}
