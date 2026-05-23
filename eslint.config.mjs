// Like jusers.js -> using JS as a DB language

import globals from "globals";
import path from "node:path";
import {fileURLToPath} from "node:url";
import js from "@eslint/js";
import {FlatCompat} from "@eslint/eslintrc";

/*
import tseslint from 'typescript-eslint';
export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
);
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all
});

delete globals.browser['AudioWorkletGlobalScope ']; // bug in eslint 9.15.0
export default [...compat.extends("eslint:recommended"), {
  plugins: {},
  languageOptions: {
    globals: {
      ...globals.browser,
      ...globals.node,
    },
    ecmaVersion: 'latest',
    sourceType: "module",
    parserOptions: {
      ecmaFeatures: {
        jsx: true,
        // ts: true,
      },
    },
  },
  files: ["**/*.jsx", "**/*.js", "**/*.jsm", "**/*.tsx"],
  rules: {
    "no-cond-assign": 'off',
    "no-unused-vars": 'off',
    "no-constant-condition": 'off',
    "no-constant-binary-expression": "off",
    "no-unreachable": 'off',
    "no-useless-escape": 'off',
    "no-empty": 'off',
    "no-ex-assign": 'off',
    "semi": ['error', 'always'],
  },
}];
