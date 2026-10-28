import { Download } from "lucide-react";
import { toast } from "sonner";
import { useInstallPrompt } from "../../hooks/useInstallPrompt";

/**
 * Persistent "Instalar aplicativo" button on the login screen itself —
 * unlike InstallPromptModal (dismissible, and then hidden for a few days)
 * and the Topbar's InstallAppButton (hidden entirely on Android/desktop
 * until Chrome's own engagement heuristic decides to fire
 * beforeinstallprompt), this always stays visible so there's a guaranteed
 * way to install the real app — not the .apk — right on the login card.
 * See PROMPT: "No navegador do celular Android, tem que ter o botão para
 * baixar o App (nao é o apk). Inclua o botão na tela de login."
 */
export function InstallAppLink() {
  const { installed, canPromptInstall, isIosManual, promptInstall } = useInstallPrompt();

  if (installed) return null;

  function handleClick() {
    if (canPromptInstall) {
      promptInstall();
      return;
    }
    toast.info(
      isIosManual
        ? 'Toque no ícone de Compartilhar (⬆️) e depois em "Adicionar à Tela de Início".'
        : 'Toque no menu (⋮) do navegador e escolha "Instalar aplicativo" ou "Adicionar à tela inicial".',
      { duration: 8000 }
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="focus-ring mt-3 flex w-full items-center justify-center gap-2 rounded-card border border-border py-2.5 text-sm font-medium text-muted hover:bg-surface-alt"
    >
      <Download className="h-4 w-4" /> Instalar aplicativo
    </button>
  );
}
