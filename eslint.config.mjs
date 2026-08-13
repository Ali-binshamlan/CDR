import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // معامل/متغيّر مبدوء بـ_ (مثال: _credentials في Connector عقده الموحَّد
  // يفرض توقيعاً ثابتاً لا تستخدمه بعض التطبيقات فعلياً) يُستثنى صراحةً من
  // no-unused-vars — الإعداد الافتراضي وحده لا يكفي لهذا النمط (يتجاهل فقط
  // آخر معامل "بعد الاستخدام"، لا أي معامل ببادئة _ بصرف النظر عن موضعه).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
