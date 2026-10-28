import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ThemedToaster } from "./components/common/ThemedToaster";
import "@fontsource-variable/inter";
import "./styles/index.css";
import { applySavedBrandColors } from "./lib/brand-colors";

applySavedBrandColors();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ThemedToaster />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);

// Registers the no-op pass-through service worker some browsers require
// before offering "Add to Home Screen" — see PROMPT: "abrir em layout de
// aplicativo". Never blocks first paint (fires after load) and is a no-op
// in dev (no HTTPS/localhost service worker support quirks to chase) and
// on browsers without SW support at all.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
