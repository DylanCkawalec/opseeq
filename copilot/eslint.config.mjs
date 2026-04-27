import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "node_modules/**",
      "web/node_modules/**",
      "web/dist/**",
      "runs/**",
      "bin/**",
      "api/**",
    ],
  },
  {
    files: ["agents/**/*.ts", "workflow/**/*.ts", "models/**/*.ts", "mcp/**/*.ts", "obs/**/*.ts", "store/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "no-constant-condition": "warn",
      "no-console": "off",
    },
  },
];
