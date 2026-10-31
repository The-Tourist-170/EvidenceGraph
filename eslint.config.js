import js from "@eslint/js";
import react from "eslint-plugin-react";

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
    files: ["**/*.js", "**/*.jsx", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Bun: "readonly",
        File: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        document: "readonly",
        fetch: "readonly",
        window: "readonly",
        ReadableStream: "readonly",
        Request: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        performance: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    files: ["**/*.js", "**/*.jsx"],
    plugins: { react },
    settings: { react: { version: "detect" } },
    rules: {
      "react/jsx-uses-react": "error",
      "react/jsx-uses-vars": "error",
    },
  },
];
