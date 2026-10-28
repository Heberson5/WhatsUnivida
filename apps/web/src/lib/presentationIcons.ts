import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CheckCircle2, Clock, Flag, Headset, Inbox, MessageSquare, Star, Timer, Trophy, Users, type LucideIcon } from "lucide-react";
import type { PresentationIconName } from "./dashboardPresentation";

/** The same icons the Dashboard cards use, for the presentation's circles. */
export const PRESENTATION_ICON_COMPONENTS: Record<PresentationIconName, LucideIcon> = {
  inbox: Inbox,
  users: Users,
  clock: Clock,
  timer: Timer,
  check: CheckCircle2,
  messages: MessageSquare,
  star: Star,
  trophy: Trophy,
  flag: Flag,
  headset: Headset,
};

const ICON_PX = 192;
const ICON_TIMEOUT_MS = 3000;

/** The icon's SVG markup, drawn white — it always sits on a colored circle. */
function iconSvg(Icon: LucideIcon): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(createElement(Icon, { color: "#FFFFFF", size: ICON_PX, strokeWidth: 2 })));
  const svg = host.innerHTML;
  root.unmount();
  return svg;
}

/** SVG → PNG (a data: address), through a canvas. Null if the browser can't draw it in time. */
function svgToPng(svg: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => resolve(null), ICON_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timer);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = ICON_PX;
        canvas.height = ICON_PX;
        const context = canvas.getContext("2d");
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, ICON_PX, ICON_PX);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * PNG versions of the presentation's icons. PowerPoint gets pictures, not SVG, so the deck also
 * opens right in older versions and in Google Slides; an icon that can't be drawn is just left out.
 */
export async function renderPresentationIcons(): Promise<Partial<Record<PresentationIconName, string>>> {
  const entries = await Promise.all(
    (Object.entries(PRESENTATION_ICON_COMPONENTS) as [PresentationIconName, LucideIcon][]).map(async ([name, Icon]) => {
      try {
        return [name, await svgToPng(iconSvg(Icon))] as const;
      } catch {
        return [name, null] as const;
      }
    })
  );
  return Object.fromEntries(entries.filter(([, png]) => png !== null)) as Partial<Record<PresentationIconName, string>>;
}
