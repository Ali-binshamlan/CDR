// مسارا ملفَي الحالة المشتركَين بين auth.setup.ts (يكتبهما) وpm10-downwind.
// spec.ts (يقرأهما) — خارج git (راجع .gitignore، نمط .playwright/* الموجود
// أصلاً فيه لـtest-results/playwright-report).
export const E2E_FIXTURE_PATH = '.playwright/e2e-fixture.json';
export const E2E_AUTH_STATE_PATH = '.playwright/auth-state.json';
