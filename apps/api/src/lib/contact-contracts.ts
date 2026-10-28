import type { Prisma } from "@prisma/client";
import type { ContactContractDTO } from "@whatsatendende/types";

const STATUSES = new Set(["ACTIVE", "SUSPENDED", "CANCELED"]);

/** Contact.contracts (JSON, from the Fonte de dados list) as the screen gets it — anything malformed is left out. */
export function contactContractsOf(value: Prisma.JsonValue | null | undefined): ContactContractDTO[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const c = item as Record<string, Prisma.JsonValue>;
    if (typeof c.number !== "string" || !c.number) return [];
    return [
      {
        number: c.number,
        status: typeof c.status === "string" && STATUSES.has(c.status) ? (c.status as ContactContractDTO["status"]) : null,
        canceledAt: typeof c.canceledAt === "string" ? c.canceledAt : null,
        cancelReason: typeof c.cancelReason === "string" ? c.cancelReason : null,
      },
    ];
  });
}
