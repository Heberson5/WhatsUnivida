import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PERMISSION } from "@whatsunivida/types";
import { ProtectedRoute, PermissionRoute } from "./ProtectedRoute";
import { useAuthStore } from "../../store/auth-store";

function Secret() {
  return <div>Conteudo protegido</div>;
}
function Login() {
  return <div>Tela de login</div>;
}
function Home() {
  return <div>Home</div>;
}

describe("ProtectedRoute", () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: null, user: null, permissions: null, hydrated: true });
  });

  it("redirects to /login when there is no authenticated user", () => {
    render(
      <MemoryRouter initialEntries={["/atendimento"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/atendimento" element={<Secret />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/tela de login/i)).toBeInTheDocument();
  });

  it("renders the protected content when a user is authenticated", () => {
    useAuthStore.setState({
      accessToken: "token",
      user: {
        id: "1",
        fullName: "A",
        displayName: "A",
        email: "a@a.com",
        role: "AGENT",
        status: "ACTIVE",
        presence: "ONLINE",
        createdAt: "",
        lastAccessAt: null,
        whatsappConnectionId: null,
        whatsappConnectionName: null,
        whatsappConnectionStatus: null,
        workState: null,
        workCity: null,
        accessSchedule: null,
        photoUrl: null,
      },
      hydrated: true,
    });
    render(
      <MemoryRouter initialEntries={["/atendimento"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/atendimento" element={<Secret />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/conteudo protegido/i)).toBeInTheDocument();
  });

  it("PermissionRoute blocks a user lacking the required permission and redirects home", () => {
    useAuthStore.setState({
      accessToken: "token",
      user: {
        id: "1",
        fullName: "A",
        displayName: "A",
        email: "a@a.com",
        role: "AGENT",
        status: "ACTIVE",
        presence: "ONLINE",
        createdAt: "",
        lastAccessAt: null,
        whatsappConnectionId: null,
        whatsappConnectionName: null,
        whatsappConnectionStatus: null,
        workState: null,
        workCity: null,
        accessSchedule: null,
        photoUrl: null,
      },
      permissions: { [PERMISSION.USUARIOS_GERENCIAR]: false } as never,
      hydrated: true,
    });
    render(
      <MemoryRouter initialEntries={["/usuarios"]}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route element={<PermissionRoute permission={PERMISSION.USUARIOS_GERENCIAR} />}>
            <Route path="/usuarios" element={<Secret />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/^home$/i)).toBeInTheDocument();
    expect(screen.queryByText(/conteudo protegido/i)).not.toBeInTheDocument();
  });
});
