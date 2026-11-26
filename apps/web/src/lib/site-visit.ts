import { useEffect } from "react";

/**
 * Acessos ao site: the system's own public pages (login, nova senha) report their visit — the same API the tracking
 * snippet uses on other sites (apps/api/src/modules/site-analytics). Anonymous: a random id in localStorage tells new
 * from returning visitors; no cookie, no name. Respects "Do Not Track" / Global Privacy Control.
 */

const API = "/api/public/site";
const STORAGE_KEY = "wa_site_vid";
const PING_MS = 15_000;

let visitId: string | null = null;
let startedPath: string | null = null;

function visitorId(): string {
  const make = () => `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = make();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    return make();
  }
}

function trackingAllowed(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack !== "1" && !nav.globalPrivacyControl;
}

function post(path: string, body: unknown, beacon = false) {
  const data = JSON.stringify(body);
  if (beacon && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(`${API}${path}`, data);
    return Promise.resolve(null);
  }
  return fetch(`${API}${path}`, { method: "POST", body: data, keepalive: true, headers: { "Content-Type": "text/plain" } })
    .then((r) => (r.status === 201 ? (r.json() as Promise<{ id: string }>) : null))
    .catch(() => null);
}

/** Records this public page's visit while it is open (`enabled` false: someone already logged in — not a visit). */
export function useSiteVisit(enabled = true) {
  useEffect(() => {
    if (!enabled || !trackingAllowed()) return;
    let active = 0;
    let last = Date.now();
    let visible = document.visibilityState !== "hidden";
    const tick = () => {
      const now = Date.now();
      if (visible) active += (now - last) / 1000;
      last = now;
    };
    const ping = (beacon: boolean) => {
      tick();
      // The beacon is the last word (tab closed or hidden): the visit leaves "on the site now" at once.
      if (visitId) void post(`/visits/${visitId}/ping`, { seconds: Math.round(active), ended: beacon }, beacon);
    };
    // One visit per page shown (React may run this effect twice in development: the second one reuses it).
    if (startedPath !== window.location.pathname) {
      startedPath = window.location.pathname;
      visitId = null;
      void post("/visits", { visitorId: visitorId(), url: window.location.href, title: document.title, referrer: document.referrer || null }).then((r) => {
        visitId = r?.id ?? null;
      });
    }
    const timer = window.setInterval(() => visible && ping(false), PING_MS);
    const onVisibility = () => {
      tick();
      visible = document.visibilityState !== "hidden";
      if (!visible) ping(true);
    };
    const onHide = () => ping(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      ping(true);
      startedPath = null;
    };
  }, [enabled]);
}

/** The visit to the login page ended in a login (Acessos ao site › taxa de entrada no sistema). */
export function markSiteVisitLoggedIn() {
  if (visitId) void post(`/visits/${visitId}/login`, {});
}
