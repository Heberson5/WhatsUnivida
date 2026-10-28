/**
 * Theme colors are CSS variables (the brand color is set at runtime from
 * Identidade Visual), which Tailwind can't split into RGB channels — so an
 * opacity modifier like `bg-primary/10` used to generate nothing at all.
 * Mixing with transparent makes every `/NN` modifier work on these colors.
 */
function themeColor(name) {
  return ({ opacityValue }) =>
    opacityValue === undefined || opacityValue === "1"
      ? `var(--color-${name})`
      : `color-mix(in srgb, var(--color-${name}) calc(${opacityValue} * 100%), transparent)`;
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: themeColor("primary"),
          fg: themeColor("primary-fg"),
        },
        secondary: {
          DEFAULT: themeColor("secondary"),
          fg: themeColor("secondary-fg"),
        },
        surface: themeColor("surface"),
        "surface-alt": themeColor("surface-alt"),
        border: themeColor("border"),
        muted: themeColor("muted"),
        text: themeColor("text"),
        success: { DEFAULT: themeColor("success"), soft: themeColor("success-soft") },
        warning: { DEFAULT: themeColor("warning"), soft: themeColor("warning-soft") },
        danger: { DEFAULT: themeColor("danger"), soft: themeColor("danger-soft") },
        info: { DEFAULT: themeColor("info"), soft: themeColor("info-soft") },
        side: {
          DEFAULT: themeColor("side"),
          hover: themeColor("side-hover"),
          text: themeColor("side-text"),
          muted: themeColor("side-muted"),
          strong: themeColor("side-strong"),
          border: themeColor("side-border"),
        },
      },
      borderRadius: {
        card: "12px",
      },
    },
  },
  plugins: [],
};
