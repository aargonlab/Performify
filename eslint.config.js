// ESLint 9 flat config — recommended presets for TypeScript, React (web
// components via Polaris), accessibility and import hygiene.
import js from "@eslint/js";
import { config as tsConfig, configs as tsConfigs } from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

export default tsConfig(
  {
    ignores: [
      "node_modules/**",
      "build/**",
      "public/build/**",
      ".react-router/**",
      ".shopify/**",
      "extensions/**/dist/**",
    ],
  },
  js.configs.recommended,
  ...tsConfigs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ...react.configs.flat.recommended,
    ...react.configs.flat["jsx-runtime"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: { ...globals.browser, ...globals.node, shopify: "readonly" },
    },
    settings: {
      react: { version: "detect" },
      formComponents: ["Form"],
      linkComponents: [
        { name: "Link", linkAttribute: "to" },
        { name: "NavLink", linkAttribute: "to" },
      ],
      "import/internal-regex": "^~/",
      "import/resolver": {
        node: { extensions: [".ts", ".tsx"] },
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      // Polaris web components use custom attributes (variant, tone, …)
      "react/no-unknown-property": ["error", { ignore: ["variant"] }],
    },
  },
);
