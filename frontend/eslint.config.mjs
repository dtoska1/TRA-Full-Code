import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  // ✅ Ignore build artifacts + deps
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "dist/**",
      "coverage/**",
      ".next-env.d.ts",
      "**/*.d.ts",
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // ✅ TypeScript + Next + React Hooks for app code
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "@next/next": next,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // Next.js App Router: this rule is for pages router
      "@next/next/no-html-link-for-pages": "off",
    },
  },
];