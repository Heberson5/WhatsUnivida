import { useSyncExternalStore } from "react";

// Tailwind's md breakpoint: below it, screens that have a phone layout (e.g. Gestão's cards) use it.
const PHONE_MEDIA = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(PHONE_MEDIA);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** True on a phone-sized screen; follows rotation and window resizes. */
export function useIsPhone() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_MEDIA).matches);
}
