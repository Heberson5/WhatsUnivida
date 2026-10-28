import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import { columnLabel, type Permission, type PermissionDefinition, type Role } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { UnsavedChangesBar } from "../../components/common/UnsavedChangesBar";
import { useAuthStore } from "../../store/auth-store";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

interface PermissionsResponse {
  definitions: PermissionDefinition[];
  matrix: Record<Role, Record<Permission, boolean>>;
}

const EDITABLE_ROLES: { role: Role; label: string }[] = [
  { role: "AGENT", label: "Atendente" },
  { role: "MANAGER", label: "Gestor" },
];

export function PermissionsPanel() {
  const columnView = useColumnView("permissoes");
  const queryClient = useQueryClient();
  const setSession = useAuthStore((s) => s.setSession);
  const { accessToken, user } = useAuthStore();
  const { data, isLoading } = useQuery({
    queryKey: ["permissions"],
    queryFn: async () => (await api.get<PermissionsResponse>("/permissions")).data,
  });

  // Local edit buffer — only sent to the server on "Salvar alterações", so a
  // toggle can be reverted mid-edit without round-tripping every click.
  const [draft, setDraft] = useState<Record<Role, Record<Permission, boolean>> | null>(null);
  // Menus folded up by the arrow — none when the page opens.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (data) setDraft(data.matrix);
  }, [data]);

  const dirty = data && draft ? JSON.stringify(data.matrix) !== JSON.stringify(draft) : false;

  const saveMutation = useMutation({
    mutationFn: () => {
      const entries: { role: Role; permission: Permission; allowed: boolean }[] = [];
      for (const { role } of EDITABLE_ROLES) {
        for (const def of data!.definitions) {
          const allowed = draft![role][def.key];
          if (allowed !== data!.matrix[role][def.key]) entries.push({ role, permission: def.key, allowed });
        }
      }
      return api.put<PermissionsResponse>("/permissions", { entries });
    },
    onSuccess: (res) => {
      queryClient.setQueryData(["permissions"], res.data);
      setDraft(res.data.matrix);
      // The permissions saved here may be the current admin's own (an ADMIN
      // editing MANAGER/AGENT rows never affects themselves, but keeping
      // this unconditional is harmless and covers the rare case of an admin
      // testing this from a MANAGER account with configuracoes.gerenciar).
      if (accessToken && user) setSession(accessToken, user, res.data.matrix[user.role]);
      toast.success("Permissões atualizadas.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function toggle(role: Role, permission: Permission) {
    setDraft((prev) => (prev ? { ...prev, [role]: { ...prev[role], [permission]: !prev[role][permission] } } : prev));
  }

  if (isLoading || !data || !draft) {
    return <div className="shadow-soft max-w-3xl rounded-card border border-border bg-surface p-6 text-sm text-muted">Carregando...</div>;
  }

  const groups = Array.from(new Set(data.definitions.map((d) => d.group)));
  const toggleGroup = (group: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  return (
    <div className="shadow-soft max-w-3xl space-y-6 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Permissões por perfil</h2>
        <p className="mt-1 text-sm text-muted">
          Controle, em detalhe, o que cada perfil de usuário pode acessar e fazer. O perfil Administrador sempre tem
          acesso total — por segurança, isso não pode ser alterado, para que nunca seja possível ficar sem acesso a
          esta própria tela.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setCollapsed(new Set())}
          className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt"
        >
          Expandir tudo
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(new Set(groups))}
          className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt"
        >
          Recolher tudo
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="w-0 py-2 pl-2 pr-0">
                <ColumnViewMenu view={columnView} />
              </th>
              {columnView.visibleKeys.map((key) => (
                <th key={key} className={clsx("px-2 py-2", key !== "permission" && "text-center")}>
                  {columnLabel("permissoes", key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group}>
                <tr className="bg-surface-alt/60">
                  <td colSpan={columnView.visibleKeys.length + 1} className="p-0">
                    {/* Each menu folds up — the arrow on the right; the page opens with all of them expanded. */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(group)}
                      aria-expanded={!collapsed.has(group)}
                      className="focus-ring flex w-full items-center justify-between px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted hover:text-[var(--color-text)]"
                    >
                      {group}
                      {collapsed.has(group) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </td>
                </tr>
                {data.definitions
                  .filter((d) => d.group === group && !collapsed.has(group))
                  .map((def) => (
                    <tr key={def.key} className="border-b border-border last:border-b-0">
                      <td className="w-0 p-0" />
                      {columnView.visibleKeys.map((key) => {
                        if (key === "permission") {
                          return (
                            <td key={key} className="px-2 py-2.5">
                              <p className="font-medium">{def.label}</p>
                              <p className="text-xs text-muted">{def.description}</p>
                            </td>
                          );
                        }
                        if (key === "ADMIN") {
                          return (
                            <td key={key} className="px-2 py-2.5 text-center">
                              <span title="Administrador sempre tem acesso total">
                                <ShieldCheck className="mx-auto h-4 w-4 text-primary" />
                              </span>
                            </td>
                          );
                        }
                        const role = key as Role;
                        return (
                          <td key={key} className="px-2 py-2.5 text-center">
                            {def.editableRoles.includes(role) ? (
                              <input type="checkbox" checked={draft[role][def.key]} onChange={() => toggle(role, def.key)} aria-label={`${def.label} - ${role}`} />
                            ) : (
                              // Not offered to this profile at all (e.g. media in Respostas is for Gestor and Administrador only).
                              <span className="text-xs text-muted" title="Não disponível para este perfil">
                                —
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!dirty || saveMutation.isPending}
          className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
        >
          Salvar alterações
        </button>
      </div>
      <UnsavedChangesBar dirty={dirty} saving={saveMutation.isPending} onSave={() => saveMutation.mutate()} onDiscard={() => data && setDraft(data.matrix)} />
    </div>
  );
}
