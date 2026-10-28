import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { UserDTO } from "@whatsatendende/types";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";
import { LAST_ACTIVITY_KEY, useIdleLogout } from "./useIdleLogout";

vi.mock("../lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const posts = () => vi.mocked(api.post).mock.calls.map((call) => call[0]);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

async function start() {
  useAuthStore.getState().setSession("token-1", { id: "u1" } as UserDTO);
  renderHook(() => useIdleLogout(), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(0)); // the configured limit arrives (8 hours)
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const loggedIn = () => useAuthStore.getState().accessToken !== null;

describe("logoff por inatividade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    vi.mocked(api.get).mockResolvedValue({ data: { inactivityTimeoutMinutes: 480 } });
    vi.mocked(api.post).mockReset().mockResolvedValue({ data: null });
  });

  afterEach(() => {
    act(() => useAuthStore.getState().clearSession());
    vi.useRealTimers();
  });

  it("a renovação do token a cada 15 minutos não reinicia a contagem: parado a noite toda, sai", async () => {
    await start();
    for (let i = 1; i <= 32; i++) {
      await advance(15 * MINUTE);
      if (!loggedIn()) break;
      act(() => useAuthStore.getState().setSession(`token-${i + 1}`, { id: "u1" } as UserDTO));
    }
    expect(loggedIn()).toBe(false);
    expect(posts()).toContain("/auth/logout");
  });

  it("sai logo depois do limite, não antes", async () => {
    await start();
    await advance(8 * HOUR - MINUTE);
    expect(loggedIn()).toBe(true);
    await advance(2 * MINUTE);
    expect(loggedIn()).toBe(false);
  });

  it("quem usa o sistema continua conectado", async () => {
    await start();
    for (let i = 0; i < 12; i++) {
      await advance(HOUR);
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown"));
      });
    }
    expect(loggedIn()).toBe(true);
  });

  it("uso em outra aba do sistema também conta", async () => {
    await start();
    await advance(7 * HOUR);
    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
    await advance(7 * HOUR);
    expect(loggedIn()).toBe(true);
    await advance(2 * HOUR);
    expect(loggedIn()).toBe(false);
  });

  it("avisa o servidor que está em uso no máximo a cada 30 segundos", async () => {
    await start();
    await advance(31 * 1000);
    for (let i = 0; i < 20; i++) {
      act(() => {
        window.dispatchEvent(new MouseEvent("mousemove"));
      });
      await advance(1000);
    }
    expect(posts().filter((url) => url === "/auth/activity")).toHaveLength(1);
  });

  it("computador que dormiu além do limite: ao voltar para a aba, sai na hora", async () => {
    await start();
    act(() => {
      vi.setSystemTime(Date.now() + 10 * HOUR); // the timers didn't run while it slept
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(0);
    expect(loggedIn()).toBe(false);
  });
});
