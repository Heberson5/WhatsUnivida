import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { TimelineByDay, type TimelineEntry } from "./TimelineByDay";

const local = (year: number, month: number, day: number, hour = 12, minute = 0, second = 0) => new Date(year, month - 1, day, hour, minute, second);
const entry = (key: string, date: Date): TimelineEntry => ({ key, at: date.getTime(), node: <p>{`mensagem ${key}`}</p> });
const groupNames = () => screen.queryAllByRole("group").map((g) => g.getAttribute("aria-label"));

describe("TimelineByDay", () => {
  beforeEach(() => {
    // Wednesday, 7 Oct 2026, noon.
    vi.useFakeTimers({ now: local(2026, 10, 7, 12, 0), toFake: ["Date", "setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens each day with its cut, oldest first, with the day's entries under it", () => {
    render(
      <TimelineByDay
        entries={[
          entry("a", local(2026, 9, 25, 9, 12)),
          entry("b", local(2026, 10, 3, 14, 3)),
          entry("c", local(2026, 10, 6, 16, 40)),
          entry("d", local(2026, 10, 7, 8, 31)),
          entry("e", local(2026, 10, 7, 8, 35)),
        ]}
      />
    );
    expect(groupNames()).toEqual(["25/09/2026", "Sábado", "Ontem", "Hoje"]);

    const today = screen.getByRole("group", { name: "Hoje" });
    expect(within(today).getByText("mensagem d")).toBeInTheDocument();
    expect(within(today).getByText("mensagem e")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Ontem" })).getByText("mensagem c")).toBeInTheDocument();
    // Each cut is shown as text too.
    for (const label of ["25/09/2026", "Sábado", "Ontem", "Hoje"]) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("shows a cut only once for a day, however many entries it has", () => {
    render(<TimelineByDay entries={[entry("a", local(2026, 10, 7, 8, 0)), entry("b", local(2026, 10, 7, 9, 0)), entry("c", local(2026, 10, 7, 10, 0))]} />);
    expect(groupNames()).toEqual(["Hoje"]);
    expect(screen.getAllByText("Hoje")).toHaveLength(1);
  });

  it("renders nothing for an empty thread", () => {
    render(<TimelineByDay entries={[]} />);
    expect(groupNames()).toEqual([]);
  });

  it("pins the cut to the top of the scrolling area, without catching clicks meant for the messages", () => {
    render(<TimelineByDay entries={[entry("a", local(2026, 10, 7, 8, 0))]} />);
    const cut = screen.getByText("Hoje");
    expect(cut).toHaveClass("sticky", "top-0");
    expect(cut).toHaveClass("pointer-events-none");
  });

  it("turns Hoje into Ontem by itself when midnight passes", () => {
    vi.setSystemTime(local(2026, 10, 7, 23, 59, 30));
    render(<TimelineByDay entries={[entry("a", local(2026, 10, 7, 10, 0))]} />);
    expect(groupNames()).toEqual(["Hoje"]);

    act(() => {
      vi.advanceTimersByTime(31_000); // up to 00:00:01
    });
    expect(groupNames()).toEqual(["Ontem"]);
  });

  it("updates when a sleeping computer or background tab wakes up on a later day", () => {
    render(<TimelineByDay entries={[entry("a", local(2026, 10, 7, 10, 0))]} />);
    expect(groupNames()).toEqual(["Hoje"]);

    // The timer never got to fire (the machine was asleep): the clock is simply a day ahead on wake-up.
    vi.setSystemTime(local(2026, 10, 8, 9, 0));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(groupNames()).toEqual(["Ontem"]);
  });

  it("leaves no timer running after it is removed", () => {
    const { unmount } = render(<TimelineByDay entries={[entry("a", local(2026, 10, 7, 10, 0))]} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
