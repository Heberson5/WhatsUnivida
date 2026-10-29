import type { ArrivalsByHourDTO } from "@whatsatendende/types";

/**
 * Shapes the presentation shares with the Dashboard screen (TeamCards, the hour-range menus and the arrivals chart
 * re-export these), so the deck built in the browser and the one the server sends by e-mail read the same data.
 */

export interface HourRange {
  start: number;
  end: number;
}

export interface TeamData {
  now: {
    online: number;
    paused: number;
    offline: number;
    pausedUsers: { userId: string; name: string; photoUrl: string | null; reasonName: string | null; since: string | null }[];
  };
  agents: {
    agentId: string;
    agentName: string;
    photoUrl: string | null;
    presence: "ONLINE" | "AWAY" | "OFFLINE";
    pauseReasonName: string | null;
    onlineMs: number;
    pausedMs: number;
  }[];
}

/** The figures above the arrivals chart: the busiest hour, the total and the share outside the hours. */
export function arrivalsSummary(data: ArrivalsByHourDTO | undefined | null) {
  const hours = data?.hours ?? [];
  const total = hours.reduce((sum, h) => sum + h.inside + h.outside, 0);
  const outside = hours.reduce((sum, h) => sum + h.outside, 0);
  const peak = hours.reduce<ArrivalsByHourDTO["hours"][number] | null>((best, h) => (h.inside + h.outside > (best ? best.inside + best.outside : 0) ? h : best), null);
  return { total, peakHour: peak?.hour ?? null, outsideShare: total ? Math.round((outside / total) * 100) : 0 };
}
