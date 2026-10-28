import type { LucideIcon } from "lucide-react";

/**
 * Placeholder for a channel whose integration doesn't exist yet (Instagram,
 * Facebook, Site) — the tab already exists so the admin has one place to
 * look for every channel, but there is no backend behind it to call yet.
 */
export function ChannelComingSoonPanel({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="shadow-soft flex flex-col items-center gap-3 rounded-card border border-border bg-surface p-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-alt text-muted">
        <Icon className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted">{description}</p>
      <span className="rounded-full bg-secondary/40 px-3 py-1 text-xs font-medium text-text">Em breve</span>
    </div>
  );
}
