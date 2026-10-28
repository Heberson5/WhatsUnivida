import { Download } from "lucide-react";
import { toast } from "sonner";
import { useInstallPrompt } from "../../hooks/useInstallPrompt";

// Explicit, always-visible install action — shown on both desktop (Chrome/
// Edge, where clicking it triggers the same native install dialog as the
// browser's own address-bar icon) and mobile (Android gets the native
// dialog too; iOS Safari, which never fires beforeinstallprompt at all,
// gets on-screen manual instructions instead) — see PROMPT: "verifique se
// tem a função de instalar o aplicativo no computador e se for aberto em
// celular, ter a opção de instalar o app".
export function InstallAppButton() {
  const { installed, canPromptInstall, isIosManual, promptInstall } = useInstallPrompt();

  if (installed || (!canPromptInstall && !isIosManual)) return null;

  function handleClick() {
    if (canPromptInstall) {
      promptInstall();
      return;
    }
    toast.info("Para instalar: toque no ícone de Compartilhar e depois em \"Adicionar à Tela de Início\".", {
      duration: 8000,
    });
  }

  return (
    <button
      onClick={handleClick}
      className="focus-ring flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-alt"
      aria-label="Instalar aplicativo"
      title="Instalar aplicativo"
    >
      <Download className="h-4 w-4" />
      <span className="hidden sm:inline">Instalar app</span>
    </button>
  );
}
