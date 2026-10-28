import axios from "axios";
import { useAuthStore } from "../store/auth-store";

export const api = axios.create({
  baseURL: "/api",
  withCredentials: true, // send the httpOnly refresh-token cookie
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Dashboard/report "hoje", "este mês" etc. and every date/time column they
  // print are computed server-side, but the API container's clock has no
  // reason to sit in the viewer's own timezone — so every request to these
  // endpoints carries the browser's UTC offset and the server computes
  // "today" and formats dates against that instead of its own local time.
  if (config.url?.startsWith("/reports") || config.url?.startsWith("/dashboard")) {
    config.params = { ...config.params, tzOffsetMinutes: new Date().getTimezoneOffset() };
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry && original.url !== "/auth/refresh") {
      original._retry = true;
      if (!refreshPromise) {
        refreshPromise = api
          .post("/auth/refresh", null, { params: { tzOffsetMinutes: new Date().getTimezoneOffset() } })
          .then((res) => {
            useAuthStore.getState().setSession(res.data.accessToken, res.data.user, res.data.permissions);
            return res.data.accessToken as string;
          })
          .catch(() => {
            useAuthStore.getState().clearSession();
            return null;
          })
          .finally(() => {
            refreshPromise = null;
          });
      }
      const newToken = await refreshPromise;
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  }
);

/**
 * Appends the current access token as a query param — needed for any URL
 * handed to an <img>/<video>/<audio> tag or a plain download link, since
 * those can't attach an Authorization header the way axios requests do.
 * The corresponding route (message attachment download) accepts the token
 * either way — see messages.routes.ts.
 */
export function withAuthToken(url: string): string {
  const token = useAuthStore.getState().accessToken;
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export interface ApiErrorShape {
  error: string;
  message: string;
  details?: unknown;
}

export function getApiErrorMessage(err: unknown, fallback = "Ocorreu um erro inesperado"): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as ApiErrorShape | undefined;
    return data?.message ?? fallback;
  }
  return fallback;
}
