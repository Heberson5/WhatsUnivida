import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { LinkPreviewDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Preview card for a link in a message, fetched by the server on demand — nothing is shown while loading or when the page has no preview. */
export function LinkPreviewCard({ url }: { url: string }) {
  const { data } = useQuery({
    queryKey: ["link-preview", url],
    queryFn: async () => (await api.get<LinkPreviewDTO | null>("/link-preview", { params: { url } })).data,
    staleTime: ONE_DAY_MS,
    retry: false,
  });
  if (!data) return null;
  return (
    <a href={data.url} target="_blank" rel="noreferrer" className="mb-1.5 flex overflow-hidden rounded border border-black/10 bg-black/5 hover:bg-black/10">
      {data.thumbnailUrl && <img src={data.thumbnailUrl} alt="" className="h-16 w-16 shrink-0 object-cover" />}
      <div className="min-w-0 px-2 py-1.5">
        <p className="line-clamp-2 text-xs font-semibold">{data.title}</p>
        {data.description && <p className="line-clamp-2 text-xs opacity-75">{data.description}</p>}
        <p className="flex items-center gap-1 truncate text-[11px] opacity-60">
          <ExternalLink className="h-3 w-3 shrink-0" /> {hostOf(data.url)}
        </p>
      </div>
    </a>
  );
}
