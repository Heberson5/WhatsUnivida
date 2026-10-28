import { useEffect, useState } from "react";

/** Current time, refreshed every `intervalMs` — for labels like "sem resposta há 12 min". */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
