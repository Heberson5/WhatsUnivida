import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { CheckCircle2, Lock } from "lucide-react";
import { PERMISSION, type BoletoBankValidationDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

/**
 * Before a bank sends boletos, its boletos must match real ones: type the
 * nosso número and the linha digitável of a real boleto (already in the
 * active source); 3 identical ones enable the bank.
 */
export function BoletoValidationSection() {
  const queryClient = useQueryClient();
  const canEdit = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.FONTES_DADOS_EDITAR]));
  const { data: banks } = useQuery({ queryKey: ["boleto-validation"], queryFn: async () => (await api.get<BoletoBankValidationDTO[]>("/boletos/validation")).data });
  const [ourNumber, setOurNumber] = useState("");
  const [linha, setLinha] = useState("");

  const submitMutation = useMutation({
    mutationFn: async () => (await api.post<BoletoBankValidationDTO[]>("/boletos/validation", { ourNumber, linha })).data,
    onSuccess: (data) => {
      queryClient.setQueryData(["boleto-validation"], data);
      setOurNumber("");
      setLinha("");
      toast.success("Confere! Boleto real validado.");
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ["boleto-validation"] });
      toast.error(getApiErrorMessage(err));
    },
  });
  const resetMutation = useMutation({
    mutationFn: async (bank: string) => (await api.delete<BoletoBankValidationDTO[]>(`/boletos/validation/${bank}`)).data,
    onSuccess: (data) => queryClient.setQueryData(["boleto-validation"], data),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="shadow-soft max-w-3xl rounded-card border border-border bg-surface p-6">
      <h2 className="text-base font-semibold">Validação de boletos</h2>
      <p className="mt-1 text-sm text-muted">
        O boleto é gerado só com os dados da fonte, nunca com uma linha digitada. Antes de liberar um banco, confira 3 boletos reais: informe o nosso número e a linha
        digitável de cada um. O banco só é liberado quando os 3 saírem idênticos.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {banks?.map((bank) => (
          <div key={bank.code} className={clsx("rounded-card border p-3 text-sm", bank.enabled ? "border-success" : "border-border")}>
            <p className="flex items-center gap-1.5 font-semibold">
              {bank.enabled ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Lock className="h-4 w-4 text-muted" />}
              {bank.name} ({bank.code})
            </p>
            <p className="text-xs text-muted">{bank.enabled ? "Envio liberado" : `Bloqueado · ${bank.matched} de ${bank.required} boletos conferidos`}</p>
            {bank.lastFailure && !bank.enabled && <p className="mt-1 text-xs text-danger">Última conferência: {bank.lastFailure}</p>}
            {canEdit && bank.matched > 0 && (
              <button
                type="button"
                onClick={() => window.confirm(`Bloquear de novo o ${bank.name} e apagar as conferências?`) && resetMutation.mutate(bank.code)}
                className="focus-ring mt-1 text-xs text-danger hover:underline"
              >
                Bloquear de novo
              </button>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Nosso número</span>
            <input value={ourNumber} onChange={(e) => setOurNumber(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Linha digitável do boleto real</span>
            <input value={linha} onChange={(e) => setLinha(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 font-mono text-sm" />
          </label>
          <button
            type="button"
            onClick={() => submitMutation.mutate()}
            disabled={submitMutation.isPending || !ourNumber.trim() || linha.replace(/\D/g, "").length !== 47}
            className="focus-ring rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            Conferir
          </button>
        </div>
      )}
    </div>
  );
}
