import type { User, WhatsAppConnection } from "@prisma/client";
import type { AccessSchedule, UserDTO } from "@whatsunivida/types";

type UserWithConnection = User & { whatsappConnection: WhatsAppConnection | null };

export function toUserDTO(user: UserWithConnection): UserDTO {
  return {
    id: user.id,
    fullName: user.fullName,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    status: user.status,
    presence: user.presence,
    photoUrl: user.photoUrl,
    whatsappConnectionId: user.whatsappConnectionId,
    whatsappConnectionName: user.whatsappConnection?.name ?? null,
    whatsappConnectionStatus: user.whatsappConnection?.status ?? null,
    createdAt: user.createdAt.toISOString(),
    lastAccessAt: user.lastAccessAt ? user.lastAccessAt.toISOString() : null,
    workState: user.workState,
    workCity: user.workCity,
    accessSchedule: (user.accessSchedule as AccessSchedule | null) ?? null,
  };
}
