import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia; useTheme reads it to resolve the "AUTO" theme.
// (A few tests run in the node environment, where there is no window at all.)
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
