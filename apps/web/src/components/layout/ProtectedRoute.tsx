import { Navigate, Outlet } from "react-router-dom";
import type { Permission } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";

export function ProtectedRoute() {
  const { user, hydrated } = useAuthStore();
  if (!hydrated) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Gates a route behind a permission from Configurações > Permissões instead of a fixed role list — see @whatsatendende/types' PERMISSION_DEFINITIONS. */
export function PermissionRoute({ permission }: { permission: Permission }) {
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  if (!user) return <Navigate to="/login" replace />;
  if (!permissions?.[permission]) return <Navigate to="/" replace />;
  return <Outlet />;
}
