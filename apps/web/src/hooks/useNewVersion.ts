import { useEffect, useState } from "react";

// A page left open across a deploy keeps running the old code. It compares its
// own build id with the deployed one (/version.json, written by vite.config.ts)
// every CHECK_INTERVAL_MS, when the tab comes back into view and when the
// network returns — a deploy restarts the server, so that's when it shows up.
export const CHECK_INTERVAL_MS = 2 * 60_000;
const RELOAD_CHANNEL = "wa-new-version";

/** This page's build; "dev" outside a production build (no /version.json there). */
export const currentBuildId = (): string => (typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev");

export async function fetchDeployedBuildId(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" && body.id ? body.id : null;
  } catch {
    return null;
  }
}

/** Reloads this tab and tells the other open tabs to do the same (each one waits for its own unsent message). */
export function reloadToNewVersion() {
  try {
    const channel = new BroadcastChannel(RELOAD_CHANNEL);
    channel.postMessage("reload");
    channel.close();
  } catch {
    // no BroadcastChannel: only this tab reloads
  }
  window.location.reload();
}

/** True once a newer build than this page's has been deployed. */
export function useNewVersionAvailable(onReloadRequestedElsewhere?: () => void): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const mine = currentBuildId();
    if (mine === "dev") return;
    let stopped = false;
    const check = async () => {
      const deployed = await fetchDeployedBuildId();
      if (!stopped && deployed && deployed !== mine) setAvailable(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  useEffect(() => {
    if (!onReloadRequestedElsewhere) return;
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(RELOAD_CHANNEL);
      channel.onmessage = (event) => {
        if (event.data === "reload") onReloadRequestedElsewhere();
      };
    } catch {
      // no BroadcastChannel
    }
    return () => channel?.close();
  }, [onReloadRequestedElsewhere]);

  return available;
}
