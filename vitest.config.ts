import { defineConfig } from 'vitest/config';
import path from 'path';

// اختبارات وحدة لمحرّكات المؤشرات (غبار/امتثال) — دوال منطق نقية
// بلا شبكة. الـ alias @/ يطابق tsconfig.json حتى تُحلّ الاستيرادات نفسها.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['app/**/*.test.ts'],
    environment: 'node',
  },
});
