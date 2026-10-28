import type { PauseReason } from "@prisma/client";
import type { PauseReasonDTO } from "@whatsatendende/types";

export function toPauseReasonDTO(r: PauseReason): PauseReasonDTO {
  return { id: r.id, name: r.name, active: r.active };
}
