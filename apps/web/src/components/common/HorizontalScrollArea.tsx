import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";

/**
 * A wide table's scroll box that SAYS it scrolls sideways: a soft shadow on the side that still has columns, and a
 * "Mais colunas" button that slides to them. Without it a cut-off last column ("Aceite" in Relatórios) looked like
 * the end of the table.
 */
export function HorizontalScrollArea({ children, className, innerClassName }: { children: ReactNode; className?: string; innerClassName?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className={clsx("relative min-h-0", className)}>
      <div ref={ref} onScroll={measure} className={clsx("h-full overflow-auto", innerClassName)}>
        {children}
      </div>
      {edges.left && <div className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-8 rounded-l-card bg-gradient-to-r from-black/10 to-transparent" aria-hidden />}
      {edges.right && (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-0 z-[2] w-12 rounded-r-card bg-gradient-to-l from-black/15 to-transparent" aria-hidden />
          <button
            type="button"
            onClick={() => ref.current?.scrollBy({ left: ref.current.clientWidth * 0.7, behavior: "smooth" })}
            className="focus-ring absolute bottom-3 right-3 z-[3] inline-flex items-center gap-0.5 rounded-full bg-[var(--color-text)] py-1 pl-2.5 pr-1.5 text-[11.5px] font-semibold text-surface shadow-elevated hover:opacity-90"
          >
            Mais colunas <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
