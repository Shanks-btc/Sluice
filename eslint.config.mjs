// Lint for the Slice 3 code: the web app, its tests and the scripts that drive it. The Slice 1 and 2 code is not linted here; it is held
// by the TypeScript compiler's strict settings and by its tests, and linting it would change files this slice was told to leave alone.
import js from "@eslint/js";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "apps/web/src/generated/**", "apps/web/public/**", "artifacts/**", "cache/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.mjs"], languageOptions: { globals: { ...globals.node } } },
  {
    files: ["apps/web/**/*.{ts,tsx}", "test/unit/web/**/*.ts", "test/helpers/mock-wallet.ts", "test/helpers/web-copy.ts", "test/fork/web.fork.test.ts", "scripts/web-*.ts", "src/web-content.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.mocha } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["error", "warn"] }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Rules that keep the app honest about markup: nothing injects HTML except the two places that render the repository's own documents
    // through src/lib/markdown.ts, which escapes everything.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Render documents through src/lib/markdown.ts and allow it in eslint.config.mjs for that file only." },
        { selector: "JSXAttribute[name.name='style']", message: "The Content Security Policy blocks style attributes. Use a class." },
      ],
    },
  },
  {
    files: ["apps/web/src/components/doc-view.tsx", "apps/web/src/app/page.tsx"],
    rules: { "no-restricted-syntax": ["error", { selector: "JSXAttribute[name.name='style']", message: "The Content Security Policy blocks style attributes. Use a class." }] },
  },
  {
    files: ["scripts/web-*.ts", "test/**/*.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off", "@typescript-eslint/no-unused-expressions": "off", "@typescript-eslint/no-explicit-any": "off" },
  },
);
