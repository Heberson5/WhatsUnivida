import { fillCustomerTags, fillGreetingTag } from "@whatsatendende/types";
import { env } from "../config/env";

/** {{saudacao}} at the business' local time (BUSINESS_TZ_OFFSET_MINUTES). */
export function fillGreeting(text: string, now: Date = new Date()): string {
  return fillGreetingTag(text, env.BUSINESS_TZ_OFFSET_MINUTES, now);
}

/** The tags any text sent to a customer may carry: {{cliente}}, {{primeiro_nome}} and {{saudacao}}. */
export function fillSendTags(text: string, customerName: string, savedFirstName?: string | null): string {
  return fillGreeting(fillCustomerTags(text, customerName, savedFirstName));
}
