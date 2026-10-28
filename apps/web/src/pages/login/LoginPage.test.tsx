import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LoginPage from "./LoginPage";
import { useAuthStore } from "../../store/auth-store";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: { post: vi.fn(), get: vi.fn() },
  getApiErrorMessage: () => "Nao foi possivel entrar",
}));

function renderLoginPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: null, user: null, hydrated: true });
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/settings/maintenance") return Promise.resolve({ data: { enabled: false, message: null } }) as never;
      return Promise.resolve({ data: { companyName: "WhatsAtendende", primaryColor: "#0097B4", secondaryColor: "#FFE450", logoUrl: null, faviconUrl: null } }) as never;
    });
    vi.mocked(api.post).mockReset();
  });

  it("renders e-mail, password and submit fields", async () => {
    renderLoginPage();
    expect(await screen.findByLabelText(/e-mail/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^senha$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /entrar/i })).toBeInTheDocument();
  });

  it("toggles password visibility", async () => {
    renderLoginPage();
    const passwordInput = (await screen.findByLabelText(/^senha$/i)) as HTMLInputElement;
    expect(passwordInput.type).toBe("password");
    fireEvent.click(screen.getByLabelText(/mostrar senha/i));
    expect(passwordInput.type).toBe("text");
  });

  it("submits credentials and stores the session on success", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      data: { accessToken: "token-123", user: { id: "1", displayName: "Admin", role: "ADMIN", email: "admin@test.dev" } },
    } as never);

    renderLoginPage();
    fireEvent.change(await screen.findByLabelText(/e-mail/i), { target: { value: "admin@test.dev" } });
    fireEvent.change(screen.getByLabelText(/^senha$/i), { target: { value: "***REMOVIDO***" } });
    fireEvent.click(screen.getByRole("button", { name: /entrar/i }));

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBe("token-123"));
    expect(api.post).toHaveBeenCalledWith("/auth/login", expect.objectContaining({ email: "admin@test.dev", password: "***REMOVIDO***" }));
  });

  it("shows an error message when login fails", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error("invalid"));

    renderLoginPage();
    fireEvent.change(await screen.findByLabelText(/e-mail/i), { target: { value: "admin@test.dev" } });
    fireEvent.change(screen.getByLabelText(/^senha$/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /entrar/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/nao foi possivel entrar/i);
  });

  it("shows the maintenance screen instead of the login form when maintenance mode is on, with the admin's custom message", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/settings/maintenance") return Promise.resolve({ data: { enabled: true, message: "Voltamos às 14h." } }) as never;
      return Promise.resolve({ data: { companyName: "WhatsAtendende", primaryColor: "#0097B4", secondaryColor: "#FFE450", logoUrl: null, faviconUrl: null } }) as never;
    });

    renderLoginPage();

    expect(await screen.findByText(/Voltamos às 14h\./)).toBeInTheDocument();
    expect(screen.queryByLabelText(/e-mail/i)).not.toBeInTheDocument();
  });

  it("lets an admin reveal the normal login form from the maintenance screen via 'Acesso administrativo'", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/settings/maintenance") return Promise.resolve({ data: { enabled: true, message: null } }) as never;
      return Promise.resolve({ data: { companyName: "WhatsAtendende", primaryColor: "#0097B4", secondaryColor: "#FFE450", logoUrl: null, faviconUrl: null } }) as never;
    });

    renderLoginPage();

    const adminAccessButton = await screen.findByRole("button", { name: /acesso administrativo/i });
    fireEvent.click(adminAccessButton);

    expect(await screen.findByLabelText(/e-mail/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^senha$/i)).toBeInTheDocument();
  });

  it("does not show the maintenance screen when maintenance mode is off", async () => {
    renderLoginPage();
    await screen.findByLabelText(/e-mail/i);
    expect(screen.queryByRole("button", { name: /acesso administrativo/i })).not.toBeInTheDocument();
  });
});
