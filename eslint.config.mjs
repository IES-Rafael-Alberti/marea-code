import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

const typedFiles = ["**/*.ts", "**/*.tsx"];
const boundaryFiles = [
  "**/*.boundary.ts",
  "**/adapters/**/*.ts",
  "**/platform/**/*.ts",
  "scripts/**/*.ts",
];

export default tseslint.config(
  {
    ignores: [
      "**/.stryker-tmp/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/reports/**",
      "coverage/**",
      "references/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      sonarjs,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-restricted-types": [
        "error",
        {
          types: {
            unknown: {
              message:
                "Use unknown only as immediate input in a named boundary module and parse it there.",
            },
          },
        },
      ],
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-unary-minus": "error",
      // At the enforced 100% per-file coverage, CRAP equals cyclomatic complexity.
      complexity: ["error", 21],
      "max-lines": [
        "error",
        {
          max: 499,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
      "sonarjs/cognitive-complexity": ["error", 21],
    },
  },
  {
    files: boundaryFiles,
    rules: {
      "@typescript-eslint/no-restricted-types": "off",
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-restricted-types": "off",
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{cjs,js,mjs}"],
  },
);
