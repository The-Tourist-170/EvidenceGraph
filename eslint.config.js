import js from "@eslint/js";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        Bun: "readonly",
        console: "readonly",
        process: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
  },
];
