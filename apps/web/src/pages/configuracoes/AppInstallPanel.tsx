import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, getApiErrorMessage } from "../../lib/api";
import { useBranding } from "../../hooks/useBranding";

// Separate from the "Identidade visual" card above on purpose: the in-app
// logo can be a wide image with text, but the icon shown once the app is
// installed on a phone/desktop needs to be square — see PROMPT: "quero que
// ao acessar pelo celular, tenha a opção de ser aplicativo, tanto para
// Android quanto para IOS... Deve ter nas configurações a opção de incluir
// o ícone e nome do aplicativo" and "acrescente aplicativo para computador
// também".
export function AppInstallPanel() {
  const { data: branding } = useBranding();
  const queryClient = useQueryClient();
  const [appName, setAppName] = useState(branding?.appName ?? branding?.companyName ?? "");
  const iconInputRef = useRef<HTMLInputElement>(null);

  const nameMutation = useMutation({
    mutationFn: (name: string) => api.patch("/settings/branding", { appName: name.trim() || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Nome do aplicativo atualizado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const iconMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post("/settings/branding/app-icon", form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Ícone do aplicativo atualizado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="shadow-soft max-w-xl space-y-6 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Aplicativo (instalar no celular e no computador)</h2>
        <p className="mt-1 text-sm text-muted">
          Controla o ícone e o nome que aparecem quando alguém instala este sistema como aplicativo — pela tela
          "Adicionar à Tela de Início" no Android/iPhone, ou pelo botão "Instalar" do navegador no computador
          (Chrome/Edge). Depois de instalado, ele abre em sua própria janela, sem a barra de endereço do navegador.
        </p>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Ícone do aplicativo</p>
        {branding?.appIconUrl && (
          <img src={branding.appIconUrl} alt="Ícone atual do aplicativo" className="mb-2 h-16 w-16 rounded-2xl object-cover" />
        )}
        <input
          ref={iconInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => e.target.files?.[0] && iconMutation.mutate(e.target.files[0])}
        />
        <button
          onClick={() => iconInputRef.current?.click()}
          disabled={iconMutation.isPending}
          className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt disabled:opacity-60"
        >
          {iconMutation.isPending ? "Enviando..." : "Enviar ícone"}
        </button>
        <p className="mt-2 text-xs text-muted">
          Use uma imagem quadrada de pelo menos 512x512 pixels, sem cantos arredondados (o sistema operacional
          aplica o formato do ícone automaticamente).
        </p>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Nome do aplicativo</span>
        <input
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          maxLength={30}
          placeholder="Ex: Atendimento ACME"
          className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-xs text-muted">Aparece embaixo do ícone na tela inicial. Fica melhor com até 12 caracteres.</span>
      </label>

      <button
        onClick={() => nameMutation.mutate(appName)}
        disabled={nameMutation.isPending}
        className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
      >
        Salvar nome do aplicativo
      </button>

      <p className="text-xs text-muted">
        Quem já instalou o aplicativo antes de uma mudança precisa desinstalar e instalar novamente para ver o novo
        ícone/nome — isso é uma limitação normal desse tipo de instalação, não um erro.
      </p>
    </div>
  );
}
