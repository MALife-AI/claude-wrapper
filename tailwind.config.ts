import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        profit: '#10b981',
        loss: '#ef4444',
        neutral: '#6b7280',
        grade: {
          a: '#10b981',
          b: '#3b82f6',
          c: '#f59e0b',
          d: '#ef4444',
        },
      },
    },
  },
  plugins: [],
};

export default config;
