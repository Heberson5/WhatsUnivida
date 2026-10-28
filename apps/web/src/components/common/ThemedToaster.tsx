import { useEffect, useState } from "react";
import { Toaster } from "sonner";

// sonner can't read the app's own .dark class, so this mirrors it.
export function ThemedToaster() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  // Bottom-right so a confirmation never covers a page's own header buttons.
  return <Toaster richColors closeButton position="bottom-right" theme={dark ? "dark" : "light"} />;
}
