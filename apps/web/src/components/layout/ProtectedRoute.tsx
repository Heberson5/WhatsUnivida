import { Navigate, Outlet } from "react-router-dom";
import type { Permission } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import ForcePasswordChangePage from "../../pages/login/ForcePasswordChangePage";
import ForceTwoFactorSetupPage from "../../pages/login/ForceTwoFactorSetupPage";

export function ProtectedRoute() {
  const { user, hydrated } = useAuthStore();
  if (!hydrated) return null;
  if (!user) return <Navigate to="/login" replace />;
  // The password was chosen by someone else: nothing of the system opens until the person chooses their own.
  if (user.mustChangePassword) return <ForcePasswordChangePage />;
  // An Administrador required to use the verificação em duas etapas who hasn't switched it on yet.
  if (user.mustSetUpTwoFactor) return <ForceTwoFactorSetupPage />;
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
