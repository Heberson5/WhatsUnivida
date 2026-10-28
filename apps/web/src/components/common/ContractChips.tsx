import clsx from "clsx";
import type { ContactContractDTO } from "@whatsatendende/types";

const STATUS_STYLE: Record<NonNullable<ContactContractDTO["status"]> | "UNKNOWN", { className: string; label: string }> = {
  ACTIVE: { className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300", label: "Ativo" },
  SUSPENDED: { className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300", label: "Suspenso" },
  CANCELED: { className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300", label: "Cancelado" },
  UNKNOWN: { className: "bg-surface-alt text-muted", label: "Situação não informada" },
};

/** What the chip says on hover: the status and, for a canceled one, when and why. */
export function contractTitle(c: ContactContractDTO): string {
  const style = STATUS_STYLE[c.status ?? "UNKNOWN"];
  if (c.status !== "CANCELED") return `Contrato ${c.number} — ${style.label}`;
  return [`Contrato ${c.number} — Cancelado`, c.canceledAt && `em ${c.canceledAt}`, c.cancelReason && `Motivo: ${c.cancelReason}`].filter(Boolean).join(" · ");
}

/**
 * Contatos › Contrato from the list: each number in green (active), yellow (suspended) or red (canceled). `detailed`
 * also writes the cancellation date and reason under a canceled one (the client panel); otherwise they are on hover.
 */
export function ContractChips({ contracts, detailed }: { contracts: ContactContractDTO[]; detailed?: boolean }) {
  return (
    <span className={clsx("flex flex-wrap gap-1", detailed && "flex-col items-start")}>
      {contracts.map((c) => {
        const style = STATUS_STYLE[c.status ?? "UNKNOWN"];
        return (
          <span key={c.number} className="inline-flex flex-col">
            <span className={clsx("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums", style.className)} title={contractTitle(c)}>
              {c.number}
            </span>
            {detailed && c.status === "CANCELED" && (c.canceledAt || c.cancelReason) && (
              <span className="mt-0.5 ps-1 text-[11px] text-muted">
                Cancelado{c.canceledAt ? ` em ${c.canceledAt}` : ""}
                {c.cancelReason ? ` · ${c.cancelReason}` : ""}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
