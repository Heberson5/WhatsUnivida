import { Navigate, Route, Routes } from "react-router-dom";
import { PERMISSION } from "@whatsunivida/types";
import { useBootstrapSession } from "./hooks/useBootstrapSession";
import { useAuthStore } from "./store/auth-store";
import { ProtectedRoute, PermissionRoute } from "./components/layout/ProtectedRoute";
import { AppLayout } from "./components/layout/AppLayout";
import LoginPage from "./pages/login/LoginPage";
import ResetPasswordPage from "./pages/login/ResetPasswordPage";
import AtendimentoPage from "./pages/atendimento/AtendimentoPage";
import GestaoPage from "./pages/gestao/GestaoPage";
import DashboardPage from "./pages/dashboard/DashboardPage";
import RelatoriosPage from "./pages/relatorios/RelatoriosPage";
import UsuariosPage from "./pages/usuarios/UsuariosPage";
import RespostasRapidasPage from "./pages/respostas-rapidas/RespostasRapidasPage";
import ConfiguracoesPage from "./pages/configuracoes/ConfiguracoesPage";
import AuditoriaPage from "./pages/auditoria/AuditoriaPage";
import MeuPerfilPage from "./pages/perfil/MeuPerfilPage";

// Where "/" lands depends on what this user's role can actually reach —
// picks the first permitted destination in this priority order rather than
// assuming by role, since Configurações > Permissões can now grant/revoke
// any of these independently of role.
const HOME_PRIORITY: { permission: (typeof PERMISSION)[keyof typeof PERMISSION]; to: string }[] = [
  { permission: PERMISSION.ATENDIMENTO_ACESSAR, to: "/atendimento" },
  { permission: PERMISSION.DASHBOARD_ACESSAR, to: "/dashboard" },
  { permission: PERMISSION.GESTAO_ACESSAR, to: "/gestao" },
  { permission: PERMISSION.RELATORIOS_ACESSAR, to: "/relatorios" },
  { permission: PERMISSION.USUARIOS_GERENCIAR, to: "/usuarios" },
  { permission: PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR, to: "/respostas-rapidas" },
  { permission: PERMISSION.CONFIGURACOES_GERENCIAR, to: "/configuracoes" },
  { permission: PERMISSION.AUDITORIA_ACESSAR, to: "/auditoria" },
];

function RoleHome() {
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  if (!user) return null;
  const first = HOME_PRIORITY.find((p) => permissions?.[p.permission]);
  return <Navigate to={first?.to ?? "/perfil"} replace />;
}

export default function App() {
  useBootstrapSession();
  const hydrated = useAuthStore((s) => s.hydrated);

  if (!hydrated) {
    return <div className="flex h-screen items-center justify-center text-muted">Carregando...</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<RoleHome />} />
          <Route path="/perfil" element={<MeuPerfilPage />} />

          <Route element={<PermissionRoute permission={PERMISSION.ATENDIMENTO_ACESSAR} />}>
            <Route path="/atendimento" element={<AtendimentoPage />} />
          </Route>

          <Route element={<PermissionRoute permission={PERMISSION.GESTAO_ACESSAR} />}>
            <Route path="/gestao" element={<GestaoPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.DASHBOARD_ACESSAR} />}>
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.RELATORIOS_ACESSAR} />}>
            <Route path="/relatorios" element={<RelatoriosPage />} />
          </Route>

          <Route element={<PermissionRoute permission={PERMISSION.USUARIOS_GERENCIAR} />}>
            <Route path="/usuarios" element={<UsuariosPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR} />}>
            <Route path="/respostas-rapidas" element={<RespostasRapidasPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.CONFIGURACOES_GERENCIAR} />}>
            <Route path="/configuracoes" element={<ConfiguracoesPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.AUDITORIA_ACESSAR} />}>
            <Route path="/auditoria" element={<AuditoriaPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
