import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import type { UserScopeDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";

export interface UserScopeValue {
  allUsers: boolean;
  userIds: string[];
}

interface UserOption {
  id: string;
  displayName: string;
  presence: "ONLINE" | "AWAY" | "OFFLINE";
  whatsappConnectionName: string | null;
}

const PRESENCE_DOT: Record<UserOption["presence"], string> = { ONLINE: "bg-green-500", AWAY: "bg-yellow-500", OFFLINE: "bg-gray-400" };

export function toUserScopeValue(scope: UserScopeDTO | undefined): UserScopeValue {
  if (!scope) return { allUsers: true, userIds: [] };
  return { allUsers: scope.allUsers, userIds: scope.users.map((u) => u.id) };
}

export function describeUserScope(scope: UserScopeDTO): string {
  return scope.allUsers ? "Todos os usuários" : scope.users.map((u) => u.displayName).join(", ");
}

/** "Todos os usuários" or a checklist of users — who a message is sent for (Respostas › Aceite › "Quem pode usar"). */
export function UserScopePicker({ value, onChange, hint }: { value: UserScopeValue; onChange: (value: UserScopeValue) => void; hint: string }) {
  // Same list (and cache) as Encerramento's users.
  const { data: users } = useQuery({
    queryKey: ["agents-transfer-targets-all"],
    queryFn: async () => (await api.get<UserOption[]>("/agents/transfer-targets", { params: { excludeSelf: false } })).data,
  });

  function toggle(id: string) {
    const userIds = value.userIds.includes(id) ? value.userIds.filter((u) => u !== id) : [...value.userIds, id];
    onChange({ allUsers: false, userIds });
  }

  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-medium">Quem pode usar</legend>
      <div className="flex rounded-card border border-border p-0.5" role="radiogroup" aria-label="Quem pode usar">
        {[
          { all: true, label: "Todos os usuários" },
          { all: false, label: "Escolher usuários" },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={value.allUsers === option.all}
            onClick={() => onChange({ ...value, allUsers: option.all })}
            className={clsx(
              "focus-ring flex-1 rounded-[10px] px-2 py-1.5 text-xs font-semibold",
              value.allUsers === option.all ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {!value.allUsers && (
        <div className="mt-2 max-h-52 space-y-1 overflow-y-auto rounded-card border border-border p-1.5">
          {users?.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">Nenhum usuário ativo.</p>}
          {users?.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-alt">
              <input type="checkbox" checked={value.userIds.includes(u.id)} onChange={() => toggle(u.id)} className="h-4 w-4 accent-primary" />
              <span className={clsx("h-2 w-2 shrink-0 rounded-full", PRESENCE_DOT[u.presence])} />
              <span className="min-w-0 flex-1 truncate">{u.displayName}</span>
              {u.whatsappConnectionName && <span className="shrink-0 truncate text-[10.5px] text-muted">{u.whatsappConnectionName}</span>}
            </label>
          ))}
        </div>
      )}
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </fieldset>
  );
}
