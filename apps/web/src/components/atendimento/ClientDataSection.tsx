import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import clsx from "clsx";
import { AlertTriangle, ChevronDown, Copy, Eye, FileText, Users } from "lucide-react";
import { PERMISSION, dataColumnLabel, type ClientContractDTO, type ClientDataDTO, type ClientDataFieldDTO } from "@whatsatendende/types";
import { formatDataValue } from "../../lib/format-data-value";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { clientDataKey, useClientData } from "../../hooks/useClientData";
import { BoletoSendModal } from "./BoletoSendModal";

export const CLIENT_DATA_UNAVAILABLE = "Dados do cliente indisponíveis no momento";

function copy(value: string) {
  navigator.clipboard
    .writeText(value)
    .then(() => toast.success("Copiado."))
    .catch(() => toast.error("Não foi possível copiar."));
}

function CopyButton({ value }: { value: string }) {
  return (
    <button type="button" onClick={() => copy(value)} className="focus-ring shrink-0 rounded p-0.5 text-muted hover:text-[var(--color-text)]" aria-label="Copiar" title="Copiar">
      <Copy className="h-3 w-3" />
    </button>
  );
}

// Same rule as the API: these never get a boleto.
const NO_BOLETO_METHODS = [/cart[aã]o recorrente/i, /sem boleto/i];
const money = (value: string) => formatDataValue("valor", value);
// The client's own lines shown before "Mostrar todos".
const CLIENT_FIELDS_SHOWN = 10;

/** One line of the source: readable label, formatted value, copy — or the eye for a sensitive one not revealed yet. */
function FieldRow({ field, revealed, canReveal, onReveal }: { field: ClientDataFieldDTO; revealed?: string; canReveal: boolean; onReveal: (column: string) => void }) {
  const value = formatDataValue(field.column, revealed ?? field.value);
  const label = dataColumnLabel(field.column);
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="max-w-[45%] shrink-0 text-muted" title={field.column}>
        {label}
      </span>
      <span className="flex min-w-0 flex-1 items-start justify-end gap-1 text-right">
        <span className="min-w-0 break-words font-medium">{value}</span>
        {field.sensitive && !revealed ? (
          canReveal && (
            <button
              type="button"
              onClick={() => onReveal(field.column)}
              className="focus-ring shrink-0 rounded p-0.5 text-muted hover:text-[var(--color-text)]"
              aria-label={`Mostrar ${label}`}
              title="Mostrar (fica registrado na auditoria)"
            >
              <Eye className="h-3 w-3" />
            </button>
          )
        ) : (
          <CopyButton value={value} />
        )}
      </span>
    </div>
  );
}

function ContractCard({
  contract,
  conversationId,
  canSendBoleto,
  defaultOpen,
  renderField,
}: {
  contract: ClientContractDTO;
  conversationId: string;
  canSendBoleto: boolean;
  defaultOpen: boolean;
  renderField: (field: ClientDataFieldDTO) => React.ReactNode;
}) {
  const holderFirst = [...contract.beneficiaries].sort((a, b) => Number(b.holder) - Number(a.holder));
  const [open, setOpen] = useState(defaultOpen);
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const fields = contract.fields.filter((f) => f.value);

  /** Boletos go oldest first: checking a parcel checks every older one, unchecking clears every newer one. */
  function toggle(index: number) {
    const parcel = contract.parcels[index];
    if (selected.includes(parcel.id)) {
      setSelected(contract.parcels.slice(0, index).map((p) => p.id).filter((id) => selected.includes(id)));
      return;
    }
    const older = contract.parcels.slice(0, index).filter((p) => !selected.includes(p.id));
    if (older.length > 0) toast.info(`Envie primeiro a parcela de ${older[0].due} — não é possível pular parcelas mais antigas`);
    setSelected(contract.parcels.slice(0, index + 1).map((p) => p.id));
  }

  return (
    <div className={clsx("overflow-hidden rounded-lg border text-xs", contract.suspended ? "border-warning" : "border-border")}>
      {contract.suspended && (
        <p className="flex items-center gap-1 bg-warning px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
          <AlertTriangle className="h-3.5 w-3.5" /> Suspenso por inadimplência
        </p>
      )}
      <div className="flex items-center gap-1 bg-surface-alt px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="focus-ring flex min-w-0 flex-1 items-center justify-between gap-2 rounded text-left"
          title={open ? "Minimizar contrato" : "Mostrar o contrato"}
        >
          <span className="truncate font-semibold">Contrato {contract.number}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {/* Green active, yellow suspended, red canceled — the same colors as Contatos › Contrato. */}
            {contract.suspended ? (
              <span className="rounded-full bg-warning-soft px-2 py-px text-[11px] font-semibold text-warning">Suspenso</span>
            ) : (
              contract.status && (
                <span
                  className={clsx(
                    "rounded-full px-2 py-px text-[11px] font-semibold",
                    /^ativ/i.test(contract.status) ? "bg-success-soft text-success" : /^cancel/i.test(contract.status) ? "bg-danger-soft text-danger" : "bg-surface text-muted"
                  )}
                >
                  {contract.status}
                </span>
              )
            )}
            <ChevronDown className={clsx("h-3.5 w-3.5 text-muted transition-transform", open && "rotate-180")} />
          </span>
        </button>
        <CopyButton value={contract.number} />
      </div>
      {open && (
        <div className="space-y-2.5 px-2.5 py-2">
          {contract.plan && <p className="text-muted">{contract.plan}</p>}
          {(contract.canceledAt || contract.cancelReason) && (
            <p className="rounded-md bg-danger-soft px-2 py-1 text-danger">
              Cancelado{contract.canceledAt ? ` em ${contract.canceledAt}` : ""}
              {contract.cancelReason ? ` · Motivo: ${contract.cancelReason}` : ""}
            </p>
          )}
          {fields.length > 0 && <div className="space-y-0.5">{fields.map(renderField)}</div>}
          {contract.overdueCount > 0 && (
            <p className="font-medium text-danger">
              {contract.overdueCount} parcela{contract.overdueCount > 1 ? "s" : ""} vencida{contract.overdueCount > 1 ? "s" : ""}
            </p>
          )}
          {contract.parcels.length > 0 && (
            <ul className="space-y-1">
              {contract.parcels.map((parcel, index) => {
                const noBoleto = NO_BOLETO_METHODS.some((re) => re.test(parcel.paymentMethod ?? ""));
                return (
                  <li key={parcel.id} className="flex flex-wrap items-center gap-x-1.5">
                    {canSendBoleto && (
                      <input
                        type="checkbox"
                        checked={selected.includes(parcel.id)}
                        disabled={noBoleto}
                        onChange={() => toggle(index)}
                        title={noBoleto ? `Sem boleto: ${parcel.paymentMethod}` : "Selecionar para enviar o boleto"}
                        className="h-3.5 w-3.5 accent-[var(--color-primary)] disabled:opacity-40"
                      />
                    )}
                    <span className={clsx("tabular-nums", parcel.overdue && "font-medium text-danger")}>{parcel.due ?? "—"}</span>
                    <span className="tabular-nums">{parcel.value ? money(parcel.value) : ""}</span>
                    <span className="min-w-0 truncate text-muted">
                      {parcel.overdue ? `${parcel.daysLate} dias de atraso` : "a vencer"}
                      {noBoleto && ` · ${parcel.paymentMethod}`}
                    </span>
                    {(parcel.fine || parcel.interest || parcel.updatedValue) && (
                      <span className={clsx("basis-full tabular-nums text-muted", canSendBoleto && "ps-5")}>
                        {parcel.fine && `multa ${money(parcel.fine)}`}
                        {parcel.fine && parcel.interest && " · "}
                        {parcel.interest && `juros ${money(parcel.interest)}`}
                        {parcel.updatedValue && (
                          <>
                            {(parcel.fine || parcel.interest) && " · "}
                            atualizado <strong className="font-semibold text-text">{money(parcel.updatedValue)}</strong>
                          </>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canSendBoleto && selected.length > 0 && (
            <button type="button" onClick={() => setSending(true)} className="focus-ring inline-flex items-center gap-1 rounded-card bg-primary px-2.5 py-1 text-xs font-semibold text-primary-fg">
              <FileText className="h-3.5 w-3.5" /> Enviar boleto{selected.length > 1 ? `s (${selected.length})` : ""}
            </button>
          )}
          {holderFirst.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 font-medium">
                <Users className="h-3 w-3" /> {holderFirst.length} beneficiário{holderFirst.length > 1 ? "s" : ""}
              </p>
              <ul className="space-y-0.5">
                {holderFirst.map((b, i) => (
                  <li key={`${b.name}-${i}`} className={clsx("flex flex-wrap items-center gap-x-1", b.daysUntilBirthday === 0 && "-mx-1 rounded-md bg-secondary/30 px-1")}>
                    {b.daysUntilBirthday === 0 && <span aria-hidden>🎂</span>}
                    <span className={clsx(b.holder && "font-semibold")}>{b.name}</span>
                    <span className="text-muted">
                      · {b.relation ?? "—"}
                      {b.age !== null && ` · ${b.age} anos`}
                      {b.daysUntilBirthday !== null && b.daysUntilBirthday !== undefined && b.daysUntilBirthday > 0 && b.daysUntilBirthday <= 7 && ` · faz aniversário em ${b.daysUntilBirthday} dia${b.daysUntilBirthday > 1 ? "s" : ""}`}
                    </span>
                    {b.daysUntilBirthday === 0 && <span className="rounded bg-secondary px-1 text-[10px] font-bold text-secondary-fg">aniversário hoje</span>}
                    {b.aggregated && <span className="rounded bg-surface-alt px-1 text-[10px] font-semibold">agregado</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {sending && (
        <BoletoSendModal
          conversationId={conversationId}
          parcelIds={selected}
          onClose={() => setSending(false)}
          onSent={() => {
            setSending(false);
            setSelected([]);
          }}
        />
      )}
    </div>
  );
}

/**
 * "Dados do cliente" from the active data source. Never partial: if the
 * source is off, failing or past its limit, the attendant only sees that the
 * data is unavailable (managers also see why).
 */
export function ClientDataSection({ conversationId, readOnly }: { conversationId: string; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const canReveal = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.CLIENTE_DADOS_SENSIVEIS_VER]));
  const { data } = useClientData(conversationId);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);

  const selectMutation = useMutation({
    mutationFn: async (clientKey: string) => (await api.put<ClientDataDTO>(`/conversations/${conversationId}/client-data/client`, { clientKey })).data,
    onSuccess: (result) => queryClient.setQueryData(clientDataKey(conversationId), result),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const revealMutation = useMutation({
    mutationFn: async (column: string) => (await api.post<{ column: string; value: string }>(`/conversations/${conversationId}/client-data/reveal`, { column })).data,
    onSuccess: ({ column, value }) => setRevealed((prev) => ({ ...prev, [column]: value })),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  if (!data || data.status === "NO_SOURCE") return null;
  if (data.status === "UNAVAILABLE") {
    return (
      <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-xs">
        <p className="font-semibold">{CLIENT_DATA_UNAVAILABLE}</p>
        {data.reason && <p className="mt-0.5 text-muted">{data.reason}</p>}
      </div>
    );
  }
  if (data.status === "NOT_FOUND") return <p className="text-xs text-muted">Este telefone não está na fonte de dados.</p>;

  const updated = data.dataUpdatedAt && <p className="text-[11px] text-muted">Dados de {format(new Date(data.dataUpdatedAt), "dd/MM HH:mm")}</p>;

  if (!data.client) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Este telefone é de mais de um cliente. Qual é este atendimento?</p>
        {data.clients.map((c) => (
          <button
            key={c.key}
            type="button"
            disabled={readOnly || selectMutation.isPending}
            onClick={() => selectMutation.mutate(c.key)}
            className="focus-ring flex w-full items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-xs hover:bg-surface-alt disabled:opacity-60"
          >
            <span className="truncate font-medium">{c.name}</span>
            {c.cpfPartial && <span className="shrink-0 tabular-nums text-muted">{c.cpfPartial}</span>}
          </button>
        ))}
        {updated}
      </div>
    );
  }

  const fields = data.client.fields.filter((f) => f.value);
  const visibleFields = showAll ? fields : fields.slice(0, CLIENT_FIELDS_SHOWN);
  const renderField = (field: ClientDataFieldDTO) => (
    <FieldRow key={field.column} field={field} revealed={revealed[field.column]} canReveal={canReveal} onReveal={(column) => revealMutation.mutate(column)} />
  );
  // One contract opens by itself; with several, each shows just its number until opened. Either can be minimized.
  const singleContract = data.client.contracts.length === 1;
  return (
    <div className="space-y-2.5">
      {data.clients.length > 1 && !readOnly && (
        <select
          value={data.selectedClientKey ?? ""}
          onChange={(e) => selectMutation.mutate(e.target.value)}
          className="focus-ring w-full rounded-lg border border-border bg-surface px-2 py-1 text-xs"
          aria-label="Cliente deste atendimento"
        >
          {data.clients.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name} {c.cpfPartial ?? ""}
            </option>
          ))}
        </select>
      )}
      {data.client.contracts.map((contract) => (
        <ContractCard
          key={contract.number}
          contract={contract}
          conversationId={conversationId}
          canSendBoleto={!readOnly}
          defaultOpen={singleContract}
          renderField={renderField}
        />
      ))}
      <div className="space-y-0.5">
        {visibleFields.map(renderField)}
        {fields.length > CLIENT_FIELDS_SHOWN && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="focus-ring text-[11px] font-medium text-primary hover:underline">
            {showAll ? "Mostrar menos" : `Mostrar todas (${fields.length})`}
          </button>
        )}
      </div>
      {updated}
    </div>
  );
}
