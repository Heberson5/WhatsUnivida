/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "var(--color-primary)",
          fg: "var(--color-primary-fg)",
        },
        secondary: {
          DEFAULT: "var(--color-secondary)",
          fg: "var(--color-secondary-fg)",
        },
        surface: "var(--color-surface)",
        "surface-alt": "var(--color-surface-alt)",
        border: "var(--color-border)",
        muted: "var(--color-muted)",
      },
      borderRadius: {
        card: "12px",
      },
    },
  },
  plugins: [],
};
