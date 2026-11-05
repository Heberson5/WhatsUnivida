import clsx from "clsx";

/**
 * Grey placeholders in the shape of what's loading — the page keeps its layout while data arrives instead of a
 * "Carregando..." line that then jumps. Screen readers still hear "Carregando…" once (role="status").
 */
export function Skeleton({ className }: { className?: string }) {
  return <span className={clsx("block animate-pulse rounded-md bg-border/70 motion-reduce:animate-none", className)} aria-hidden />;
}

const ROW_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5"];

/** Table body rows while a list loads. `columns` = the table's column count (same as the old colSpan). */
export function SkeletonRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-t border-border" role={r === 0 ? "status" : undefined}>
          {Array.from({ length: Math.max(1, columns) }, (_, c) => (
            <td key={c} className="px-4 py-3.5">
              {r === 0 && c === 0 && <span className="sr-only">Carregando…</span>}
              <Skeleton className={clsx("h-3.5", ROW_WIDTHS[(r + c) % ROW_WIDTHS.length])} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A card/list area while it loads: a few lines of different widths. */
export function SkeletonBlock({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div role="status" className={clsx("space-y-2.5 py-4", className)}>
      <span className="sr-only">Carregando…</span>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={clsx("h-3.5", ROW_WIDTHS[i % ROW_WIDTHS.length])} />
      ))}
    </div>
  );
}

/** Dashboard-style number tiles while the indicators load. */
export function SkeletonTiles({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div role="status" className={clsx("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6", className)}>
      <span className="sr-only">Carregando indicadores…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="shadow-soft space-y-3 rounded-card border border-border bg-surface p-4">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** A whole screen while its code downloads (first visit to a screen). */
export function PageSkeleton() {
  return (
    <div role="status" className="space-y-5 p-4 sm:p-6">
      <span className="sr-only">Carregando…</span>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="shadow-soft space-y-4 rounded-card border border-border bg-surface p-5">
        {ROW_WIDTHS.concat(ROW_WIDTHS).map((w, i) => (
          <Skeleton key={i} className={clsx("h-3.5", w)} />
        ))}
      </div>
    </div>
  );
}
