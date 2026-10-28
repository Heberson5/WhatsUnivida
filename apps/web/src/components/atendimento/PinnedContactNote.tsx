import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { Pencil, Pin } from "lucide-react";
import { PERMISSION, type ContactPanelDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

const MAX_LENGTH = 1000;

/** "Observação fixa" of the contact, at the top of every conversation of theirs. Shares the client panel's query. */
export function PinnedContactNote({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const canEdit = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.CONTATOS_OBSERVACAO_EDITAR]));
  const queryKey = ["contact-panel", conversationId];
  const { data: panel } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<ContactPanelDTO>(`/conversations/${conversationId}/contact-panel`)).data,
  });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const saveMutation = useMutation({
    mutationFn: async (value: string | null) => (await api.put<ContactPanelDTO>(`/conversations/${conversationId}/contact-pinned-note`, { text: value })).data,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      setEditing(false);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const note = panel?.pinnedNote;
  if (!panel || (!note && !editing && !canEdit)) return null;

  if (editing) {
    return (
      <div className="mx-4 mt-2 rounded-card border border-warning bg-warning-soft p-2">
        <textarea
          autoFocus
          value={text}
          maxLength={MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Ex.: cliente prefere contato à tarde"
          className="focus-ring w-full resize-none rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
        />
        <div className="mt-1.5 flex justify-end gap-2 text-xs">
          {note && (
            <button onClick={() => saveMutation.mutate(null)} className="focus-ring mr-auto rounded-card px-2 py-1 text-danger hover:bg-surface">
              Apagar
            </button>
          )}
          <button onClick={() => setEditing(false)} className="focus-ring rounded-card px-2 py-1 hover:bg-surface">
            Cancelar
          </button>
          <button
            onClick={() => saveMutation.mutate(text.trim() || null)}
            disabled={saveMutation.isPending}
            className="focus-ring rounded-card bg-primary px-3 py-1 font-semibold text-primary-fg disabled:opacity-60"
          >
            Salvar
          </button>
        </div>
      </div>
    );
  }

  if (!note) {
    return (
      <button
        onClick={() => {
          setText("");
          setEditing(true);
        }}
        className="focus-ring mx-4 mt-2 inline-flex items-center gap-1 self-start rounded-card px-2 py-1 text-xs text-muted hover:bg-surface-alt"
      >
        <Pin className="h-3 w-3" /> Adicionar observação fixa
      </button>
    );
  }

  return (
    <div className="mx-4 mt-2 flex items-start gap-2 rounded-card border border-warning bg-warning-soft px-3 py-2 text-sm">
      <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words">{note.text}</p>
        <p className="mt-0.5 text-[11px] text-muted">
          Observação fixa{note.updatedByName ? ` · ${note.updatedByName}` : ""} · {format(new Date(note.updatedAt), "dd/MM/yyyy HH:mm")}
        </p>
      </div>
      {canEdit && (
        <button
          onClick={() => {
            setText(note.text);
            setEditing(true);
          }}
          className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface"
          aria-label="Editar observação fixa"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
