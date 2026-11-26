import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSiteVisit } from "./site-visit";

describe("Acessos ao site: a página pública do sistema registra a visita", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ status: 201, json: () => Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "doNotTrack", { value: null, configurable: true });
  });

  it("registra uma visita anônima, com um id aleatório guardado no navegador", () => {
    const { unmount } = renderHook(() => useSiteVisit(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/public/site/visits");
    const body = JSON.parse(init.body);
    expect(body.visitorId).toMatch(/^[a-z0-9]{8,64}$/);
    expect(body.visitorId).toBe(localStorage.getItem("wa_site_vid"));
    expect(body.url).toBe(window.location.href);
    unmount();
  });

  it("não registra nada com “Não rastrear”, nem para quem já entrou no sistema", () => {
    renderHook(() => useSiteVisit(false));
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    renderHook(() => useSiteVisit(true));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
