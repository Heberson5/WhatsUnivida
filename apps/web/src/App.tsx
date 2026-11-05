import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { PERMISSION } from "@whatsatendende/types";
import { useBootstrapSession } from "./hooks/useBootstrapSession";
import { useAuthStore } from "./store/auth-store";
import { ProtectedRoute, PermissionRoute } from "./components/layout/ProtectedRoute";
import { AppLayout } from "./components/layout/AppLayout";
import LoginPage from "./pages/login/LoginPage";
import ResetPasswordPage from "./pages/login/ResetPasswordPage";
import AtendimentoPage from "./pages/atendimento/AtendimentoPage";

// Each screen is its own download, fetched the first time it opens — an attendant no longer downloads the Fluxo
// editor, the PDF viewer and every report just to use Atendimento (the screen most people land on, kept in the main file).
const GestaoPage = lazy(() => import("./pages/gestao/GestaoPage"));
const AcompanharChatPage = lazy(() => import("./pages/chat-interno/AcompanharChatPage"));
const DashboardPage = lazy(() => import("./pages/dashboard/DashboardPage"));
const RelatoriosPage = lazy(() => import("./pages/relatorios/RelatoriosPage"));
const UsuariosPage = lazy(() => import("./pages/usuarios/UsuariosPage"));
const RespostasPage = lazy(() => import("./pages/respostas/RespostasPage"));
const EtiquetasPage = lazy(() => import("./pages/etiquetas/EtiquetasPage"));
const ContatosPage = lazy(() => import("./pages/contatos/ContatosPage"));
const ConexoesPage = lazy(() => import("./pages/conexoes/ConexoesPage"));
const FluxoPage = lazy(() => import("./pages/fluxo/FluxoPage"));
const FlowEditorPage = lazy(() => import("./pages/fluxo/FlowEditorPage"));
const ConfiguracoesPage = lazy(() => import("./pages/configuracoes/ConfiguracoesPage"));
const DadosPage = lazy(() => import("./pages/dados/DadosPage"));
const AuditoriaPage = lazy(() => import("./pages/auditoria/AuditoriaPage"));
const MeuPerfilPage = lazy(() => import("./pages/perfil/MeuPerfilPage"));
const LandingPagePage = lazy(() => import("./pages/landing-page/LandingPagePage"));
const NotasDeVersaoPage = lazy(() => import("./pages/notas-de-versao/NotasDeVersaoPage"));
const PopUpPage = lazy(() => import("./pages/popup/PopUpPage"));
const ComunicadosPage = lazy(() => import("./pages/comunicados/ComunicadosPage"));

// Where "/" lands depends on what this user's role can actually reach —
// picks the first permitted destination in this priority order rather than
// assuming by role, since Configurações > Permissões can now grant/revoke
// any of these independently of role.
const HOME_PRIORITY: { permission: (typeof PERMISSION)[keyof typeof PERMISSION]; to: string }[] = [
  { permission: PERMISSION.ATENDIMENTO_ACESSAR, to: "/atendimento" },
  { permission: PERMISSION.DASHBOARD_ACESSAR, to: "/dashboard" },
  { permission: PERMISSION.GESTAO_ACESSAR, to: "/gestao" },
  { permission: PERMISSION.RELATORIOS_ACESSAR, to: "/relatorios" },
  { permission: PERMISSION.USUARIOS_VISUALIZAR, to: "/usuarios" },
  { permission: PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR, to: "/respostas" },
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
    return <div className="flex h-dvh items-center justify-center text-muted">Carregando...</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<RoleHome />} />
          <Route path="/perfil" element={<MeuPerfilPage />} />
          <Route path="/notas-de-versao" element={<NotasDeVersaoPage />} />

          <Route element={<PermissionRoute permission={PERMISSION.ATENDIMENTO_ACESSAR} />}>
            <Route path="/atendimento" element={<AtendimentoPage />} />
          </Route>

          <Route element={<PermissionRoute permission={PERMISSION.GESTAO_ACESSAR} />}>
            <Route path="/gestao" element={<GestaoPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.CHAT_INTERNO_ACOMPANHAR} />}>
            <Route path="/acompanhar-chat" element={<AcompanharChatPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.CONTATOS_ACESSAR} />}>
            <Route path="/contatos" element={<ContatosPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.DASHBOARD_ACESSAR} />}>
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.RELATORIOS_ACESSAR} />}>
            <Route path="/relatorios" element={<RelatoriosPage />} />
          </Route>

          <Route element={<PermissionRoute permission={PERMISSION.USUARIOS_VISUALIZAR} />}>
            <Route path="/usuarios" element={<UsuariosPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR} />}>
            <Route path="/respostas" element={<RespostasPage />} />
          </Route>
          <Route path="/respostas-rapidas" element={<Navigate to="/respostas" replace />} />
          <Route element={<PermissionRoute permission={PERMISSION.POPUP_ACESSAR} />}>
            <Route path="/popup" element={<PopUpPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.COMUNICADOS_VER} />}>
            <Route path="/comunicados" element={<ComunicadosPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.ETIQUETAS_VISUALIZAR} />}>
            <Route path="/etiquetas" element={<EtiquetasPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.CONEXOES_GERENCIAR} />}>
            <Route path="/conexoes" element={<ConexoesPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.FLUXO_VISUALIZAR} />}>
            <Route path="/fluxo" element={<FluxoPage />} />
            <Route path="/fluxo/:id" element={<FlowEditorPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.FONTES_DADOS_VER} />}>
            <Route path="/dados" element={<DadosPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.CONFIGURACOES_GERENCIAR} />}>
            <Route path="/configuracoes" element={<ConfiguracoesPage />} />
          </Route>
          <Route element={<PermissionRoute permission={PERMISSION.LANDING_PAGE_VISUALIZAR} />}>
            <Route path="/landing-page" element={<LandingPagePage />} />
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
