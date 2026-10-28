import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Pencil, X } from "lucide-react";
import type { ContactContractDTO, ContactPanelDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { ContractChips } from "../common/ContractChips";

const MAX_CONTRACT_LENGTH = 200;

/** Contatos › Contrato under the client's name: filled from the Fonte de dados, corrected or typed by the attendant. */
export function ContactContractField({
  conversationId,
  contractNumber,
  contracts = [],
  readOnly,
}: {
  conversationId: string;
  contractNumber: string | null;
  /** From the Fonte de dados list: shown in color and replaced at each upload, so not edited here. */
  contracts?: ContactContractDTO[];
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  const save = useMutation({
    mutationFn: async (next: string) =>
      (await api.put<ContactPanelDTO>(`/conversations/${conversationId}/contact-contract`, { contractNumber: next.trim() || null })).data,
    onSuccess: (panel) => {
      queryClient.setQueryData(["contact-panel", conversationId], panel);
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setEditing(false);
      toast.success("Contrato salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  if (contracts.length > 0) {
    return (
      <div className="mt-1 flex max-w-full items-start gap-1 text-xs text-muted">
        <span className="pt-0.5">Contrato:</span>
        <ContractChips contracts={contracts} detailed />
      </div>
    );
  }

  if (editing) {
    return (
      <form
        className="mt-1.5 flex w-full items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(value);
        }}
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          maxLength={MAX_CONTRACT_LENGTH}
          placeholder="Número do contrato"
          aria-label="Contrato"
          className="focus-ring min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs"
        />
        <button type="submit" disabled={save.isPending} className="focus-ring rounded p-1 text-primary hover:bg-surface-alt disabled:opacity-60" aria-label="Salvar contrato">
          <Check className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setEditing(false)} className="focus-ring rounded p-1 text-muted hover:bg-surface-alt" aria-label="Cancelar">
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }

  return (
    <p className="mt-1 flex max-w-full items-center gap-1 text-xs text-muted">
      <span className="truncate">
        Contrato: <span className="font-medium text-[var(--color-text)]">{contractNumber || "—"}</span>
      </span>
      {!readOnly && (
        <button
          type="button"
          onClick={() => {
            setValue(contractNumber ?? "");
            setEditing(true);
          }}
          className="focus-ring shrink-0 rounded p-0.5 hover:bg-surface-alt hover:text-[var(--color-text)]"
          aria-label="Editar contrato"
          title="Editar contrato"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </p>
  );
}
