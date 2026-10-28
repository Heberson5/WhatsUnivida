// Movable Brazilian holidays all derive from Easter Sunday — see PROMPT:
// "existem alguns [feriados] que não são fixos, como por exemplo
// sexta-feira Santa, precisa ser cadastrado automaticamente". Used as a
// cross-check against BrasilAPI's own values (see holidays.service.ts),
// and as the only source if that API is ever unreachable.
//
// Anonymous Gregorian algorithm (Meeus/Jones/Butcher) — the standard,
// widely-verified method for computing the Gregorian Easter Sunday date.
export function computeEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monthDay = h + l - 7 * m + 114;
  const month = Math.floor(monthDay / 31); // 3 = March, 4 = April
  const day = (monthDay % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function computeMovableHolidays(year: number): { name: string; date: Date }[] {
  const easter = computeEasterSunday(year);
  return [
    { name: "Carnaval", date: addDays(easter, -47) },
    { name: "Sexta-feira Santa", date: addDays(easter, -2) },
    { name: "Páscoa", date: easter },
    { name: "Corpus Christi", date: addDays(easter, 60) },
  ];
}
