import type { Holiday } from "@prisma/client";
import type { HolidayDTO } from "@whatsatendende/types";

/** `year`: the year being listed — a holiday that repeats every year is shown on that year's day and month. */
export function toHolidayDTO(h: Holiday, year?: number): HolidayDTO {
  const date = h.date.toISOString().slice(0, 10);
  return {
    id: h.id,
    date: h.recurringYearly && year && h.monthDay ? `${year}-${h.monthDay}` : date,
    name: h.name,
    scope: h.scope,
    state: h.state,
    city: h.city,
    source: h.source,
    year: h.recurringYearly && year ? year : h.year,
    recurringYearly: h.recurringYearly,
  };
}
