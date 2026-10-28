import { env } from "../config/env";
import { syncDueDeviceContacts } from "../modules/whatsapp/whatsapp.service";

/** The most recent Monday 00:00 (business local time), as a real instant. */
export function lastWeeklySlotStart(now: Date, tzOffsetMinutes: number): Date {
  const local = new Date(now.getTime() - tzOffsetMinutes * 60_000);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday);
  return new Date(localMidnight + tzOffsetMinutes * 60_000);
}

/**
 * Loads each connected QR Code connection's phone address book once a week
 * (Monday 00:00) — also catching up a missed run (server down at midnight) or
 * a connection that never loaded it. Cheap to call often: it only works on
 * connections whose last load is older than the latest Monday 00:00.
 */
export async function syncContactsIfDue(now = new Date()): Promise<void> {
  await syncDueDeviceContacts(lastWeeklySlotStart(now, env.BUSINESS_TZ_OFFSET_MINUTES));
}
