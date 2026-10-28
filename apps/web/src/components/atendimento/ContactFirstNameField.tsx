import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Pencil, X } from "lucide-react";
import { firstNameOf, type ContactPanelDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

const MAX_FIRST_NAME_LENGTH = 60;

/**
 * Contatos › Primeiro nome under the client's name: how the customer is called in {{primeiro_nome}}. Empty, the first
 * word of the name is used (shown as "automático").
 */
export function ContactFirstNameField({
  conversationId,
  firstName,
  contactName,
  readOnly,
}: {
  conversationId: string;
  firstName: string | null;
  contactName: string | null;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const automatic = firstNameOf(contactName);

  const save = useMutation({
    mutationFn: async (next: string) =>
      (await api.put<ContactPanelDTO>(`/conversations/${conversationId}/contact-first-name`, { firstName: next.trim() || null })).data,
    onSuccess: (panel) => {
      queryClient.setQueryData(["contact-panel", conversationId], panel);
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setEditing(false);
      toast.success("Primeiro nome salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

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
          maxLength={MAX_FIRST_NAME_LENGTH}
          placeholder={automatic || "Primeiro nome"}
          aria-label="Primeiro nome"
          className="focus-ring min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs"
        />
        <button type="submit" disabled={save.isPending} className="focus-ring rounded p-1 text-primary hover:bg-surface-alt disabled:opacity-60" aria-label="Salvar primeiro nome">
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
        Primeiro nome:{" "}
        {firstName ? (
          <span className="font-medium text-[var(--color-text)]">{firstName}</span>
        ) : automatic ? (
          <span title="Sem primeiro nome salvo: usa a primeira palavra do nome">
            <span className="font-medium text-[var(--color-text)]">{automatic}</span> (automático)
          </span>
        ) : (
          <span className="font-medium text-[var(--color-text)]">—</span>
        )}
      </span>
      {!readOnly && (
        <button
          type="button"
          onClick={() => {
            setValue(firstName ?? "");
            setEditing(true);
          }}
          className="focus-ring shrink-0 rounded p-0.5 hover:bg-surface-alt hover:text-[var(--color-text)]"
          aria-label="Editar primeiro nome"
          title="Editar primeiro nome"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </p>
  );
}
