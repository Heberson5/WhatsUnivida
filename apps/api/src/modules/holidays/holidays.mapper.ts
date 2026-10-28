import type { Holiday } from "@prisma/client";
import type { HolidayDTO } from "@whatsunivida/types";

export function toHolidayDTO(h: Holiday): HolidayDTO {
  return {
    id: h.id,
    date: h.date.toISOString().slice(0, 10),
    name: h.name,
    scope: h.scope,
    state: h.state,
    city: h.city,
    source: h.source,
    year: h.year,
  };
}
