import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        vendime: {
          DEFAULT: "#0D9668",
          light: "#E7F7F0",
          dark: "#085041",
        },
        prokurime: {
          DEFAULT: "#1976D2",
          light: "#E3F2FD",
          dark: "#0D47A1",
        },
        konsultime: {
          DEFAULT: "#D84315",
          light: "#FBE9E7",
          dark: "#BF360C",
        },
      },
      boxShadow: {
        soft: "0 18px 60px -30px rgba(15, 23, 42, 0.28)",
      },
    },
  },
  plugins: [],
};

export default config;
