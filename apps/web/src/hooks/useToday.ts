import { useEffect, useState } from "react";
import { startOfDay } from "date-fns";

/**
 * The viewer's current day (midnight, local time). It changes by itself when
 * midnight passes — and when a sleeping computer or a background tab wakes up
 * on a later day — so a conversation left open overnight turns its "Hoje"
 * into "Ontem" without a reload.
 */
export function useToday(): Date {
  const [today, setToday] = useState(() => startOfDay(new Date()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      const current = startOfDay(new Date());
      setToday((previous) => (previous.getTime() === current.getTime() ? previous : current));
    };
    const scheduleNextMidnight = () => {
      clearTimeout(timer);
      const now = new Date();
      const justAfterMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = setTimeout(() => {
        refresh();
        scheduleNextMidnight();
      }, justAfterMidnight.getTime() - now.getTime());
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      scheduleNextMidnight();
    };

    scheduleNextMidnight();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return today;
}
