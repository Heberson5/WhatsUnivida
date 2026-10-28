import clsx from "clsx";
import { Hash, Users } from "lucide-react";
import type { AgentPresence, ChatRoomKind } from "@whatsatendende/types";

const PRESENCE_DOT: Record<AgentPresence, string> = { ONLINE: "bg-green-500", AWAY: "bg-yellow-500", OFFLINE: "bg-gray-400" };

// Each person keeps one color for their name in groups and their initials — picked from the id, so it never changes.
const PERSON_COLORS = ["#0e7490", "#be185d", "#7c3aed", "#b45309", "#15803d", "#0369a1", "#9333ea", "#c2410c", "#4d7c0f", "#be123c"];
const GROUP_GRADIENTS = [
  "linear-gradient(135deg, #fde68a, #f59e0b)",
  "linear-gradient(135deg, #c4b5fd, #7c3aed)",
  "linear-gradient(135deg, #99f6e4, #0d9488)",
  "linear-gradient(135deg, #fbcfe8, #db2777)",
  "linear-gradient(135deg, #bfdbfe, #2563eb)",
  "linear-gradient(135deg, #bbf7d0, #16a34a)",
];

function hash(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const personColor = (id: string) => PERSON_COLORS[hash(id) % PERSON_COLORS.length];

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ""))).toUpperCase();
}

export function PresenceDot({ presence, className }: { presence: AgentPresence; className?: string }) {
  return <span className={clsx("block h-2.5 w-2.5 rounded-full border-2 border-surface", PRESENCE_DOT[presence], className)} />;
}

const SIZES = { xs: "h-5 w-5 text-[9px]", sm: "h-7 w-7 text-[10px]", md: "h-9 w-9 text-xs", lg: "h-12 w-12 text-sm" } as const;

export function PersonAvatar({
  name,
  photoUrl,
  presence,
  size = "md",
  id,
  ring,
}: {
  name: string;
  photoUrl: string | null;
  presence?: AgentPresence;
  size?: keyof typeof SIZES;
  /** Gives the initials the person's own color. */
  id?: string;
  /** Green ring for the "Equipe online" strip. */
  ring?: boolean;
}) {
  const box = SIZES[size];
  return (
    <span className="relative inline-block shrink-0">
      {photoUrl ? (
        <img src={photoUrl} alt="" className={clsx("rounded-full object-cover", box, ring && "ring-2 ring-green-500 ring-offset-2 ring-offset-surface")} />
      ) : (
        <span
          className={clsx("flex items-center justify-center rounded-full font-semibold", box, id ? "text-white" : "bg-primary/10 text-primary", ring && "ring-2 ring-green-500 ring-offset-2 ring-offset-surface")}
          style={id ? { background: personColor(id) } : undefined}
        >
          {initials(name)}
        </span>
      )}
      {presence && size !== "xs" && <PresenceDot presence={presence} className="absolute -bottom-0.5 -right-0.5" />}
    </span>
  );
}

export function RoomIcon({ kind, icon, seed, size = "md" }: { kind: ChatRoomKind; icon?: string | null; seed?: string; size?: "sm" | "md" | "lg" }) {
  const box = size === "lg" ? "h-14 w-14 text-2xl rounded-2xl" : size === "sm" ? "h-7 w-7 text-sm rounded-lg" : "h-9 w-9 text-lg rounded-xl";
  if (kind === "GENERAL") {
    return (
      <span className={clsx("flex shrink-0 items-center justify-center bg-primary text-primary-fg", box)}>
        <Hash className={size === "lg" ? "h-6 w-6" : "h-4 w-4"} />
      </span>
    );
  }
  return (
    <span className={clsx("flex shrink-0 items-center justify-center text-white shadow-sm", box)} style={{ background: GROUP_GRADIENTS[hash(seed ?? "") % GROUP_GRADIENTS.length] }}>
      {icon ? <span aria-hidden>{icon}</span> : <Users className={size === "lg" ? "h-6 w-6" : "h-4 w-4"} />}
    </span>
  );
}
