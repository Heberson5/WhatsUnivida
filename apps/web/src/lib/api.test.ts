import { describe, it, expect } from "vitest";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { getApiErrorMessage } from "./api";

function httpError(status: number, data: unknown) {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  return new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", config, null, {
    status,
    statusText: "",
    headers: {},
    config,
    data,
  });
}

describe("getApiErrorMessage", () => {
  it("shows the message the API sent", () => {
    expect(getApiErrorMessage(httpError(400, { error: "BAD_REQUEST", message: "Arquivo muito grande" }))).toBe("Arquivo muito grande");
  });

  it("explains a 413 from the web server, whose body is an HTML page with no message", () => {
    const nginxPage = "<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center></body></html>";
    expect(getApiErrorMessage(httpError(413, nginxPage))).toBe("Arquivo muito grande para o servidor aceitar");
  });

  it("keeps the API's own wording when a 413 does carry one", () => {
    expect(getApiErrorMessage(httpError(413, { error: "PAYLOAD_TOO_LARGE", message: "Corpo da requisição maior que o permitido" }))).toBe(
      "Corpo da requisição maior que o permitido"
    );
  });

  it("falls back to the generic text for any other failure with no message", () => {
    expect(getApiErrorMessage(httpError(502, "<html>Bad Gateway</html>"))).toBe("Ocorreu um erro inesperado");
    expect(getApiErrorMessage(new Error("boom"))).toBe("Ocorreu um erro inesperado");
    expect(getApiErrorMessage(httpError(500, undefined), "Não foi possível salvar")).toBe("Não foi possível salvar");
  });
});
