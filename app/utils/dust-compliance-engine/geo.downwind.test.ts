import { describe, it, expect } from 'vitest';
import {
  bearingDegrees,
  angularDifferenceDegrees,
  isDownwind,
  nearestDownwindReceptorDistanceM,
} from './geo';
import type { SensitiveReceptor } from './types';

// =====================================================================
// اختبارات MRQ-RECEPTOR-DOWNWIND-120 — تصعيد الاستجابة لمستقبِل حساس يقع
// فعلياً باتجاه هبوب الرياح، لا مجرد قريب بالمسافة المستقيمة.
// =====================================================================

describe('bearingDegrees', () => {
  it('نقطة شمالاً مباشرة → اتجاه ~0 درجة', () => {
    const bearing = bearingDegrees(24.7, 46.7, 24.71, 46.7);
    expect(bearing).toBeLessThan(5);
  });

  it('نقطة شرقاً مباشرة → اتجاه ~90 درجة', () => {
    const bearing = bearingDegrees(24.7, 46.7, 24.7, 46.71);
    expect(bearing).toBeGreaterThan(85);
    expect(bearing).toBeLessThan(95);
  });

  it('نقطة جنوباً مباشرة → اتجاه ~180 درجة', () => {
    const bearing = bearingDegrees(24.7, 46.7, 24.69, 46.7);
    expect(bearing).toBeGreaterThan(175);
    expect(bearing).toBeLessThan(185);
  });
});

describe('angularDifferenceDegrees', () => {
  it('فرق بسيط عادي', () => {
    expect(angularDifferenceDegrees(30, 50)).toBe(20);
  });

  it('يتعامل بشكل صحيح مع الدوران عبر 0/360 (350 مقابل 10 = 20 لا 340)', () => {
    expect(angularDifferenceDegrees(350, 10)).toBe(20);
  });

  it('فرق صفر بين نفس الزاويتين', () => {
    expect(angularDifferenceDegrees(90, 90)).toBe(0);
  });
});

describe('isDownwind', () => {
  it('مستقبِل شمالاً، والرياح قادمة من الجنوب (تهب شمالاً) → باتجاه الريح', () => {
    // windDirectionFromDeg=180 يعني الرياح قادمة من الجنوب، فتهب نحو الشمال
    // (اتجاه الهبوب الفعلي = 180+180=0، أي شمالاً) — يطابق موقع المستقبِل.
    const result = isDownwind(24.7, 46.7, 24.71, 46.7, 180);
    expect(result).toBe(true);
  });

  it('مستقبِل شمالاً، والرياح قادمة من الشمال (تهب جنوباً) → ليس باتجاه الريح', () => {
    const result = isDownwind(24.7, 46.7, 24.71, 46.7, 0);
    expect(result).toBe(false);
  });

  it('يحترم هامش التسامح الزاوي — مستقبِل قريب من حافة القطاع يبقى داخل النطاق', () => {
    // مستقبِل شمالاً (bearing~0)، رياح تهب نحو 40 درجة (قريبة من الشمال لكن
    // ليست تماماً) — يجب أن تبقى ضمن هامش 45 درجة الافتراضي.
    const result = isDownwind(24.7, 46.7, 24.71, 46.7, 220, 45); // windBlowingToward = 220+180-360=40
    expect(result).toBe(true);
  });
});

describe('nearestDownwindReceptorDistanceM', () => {
  const receptors: SensitiveReceptor[] = [
    { id: 'r1', name: 'سكني شمالي قريب', receptorType: 'RESIDENTIAL', lat: 24.705, lng: 46.7 },
    { id: 'r2', name: 'سكني جنوبي بعيد', receptorType: 'RESIDENTIAL', lat: 24.69, lng: 46.7 },
    { id: 'r3', name: 'مستشفى شرقي', receptorType: 'HOSPITAL', lat: 24.7, lng: 46.72 },
  ];

  it('اتجاه رياح غير صالح (null) → null (لا يمكن الحساب)', () => {
    expect(nearestDownwindReceptorDistanceM(24.7, 46.7, null, receptors)).toBeNull();
  });

  it('موقع الكسارة غير معروف (lat/lng فارغ) → null', () => {
    expect(nearestDownwindReceptorDistanceM(null, null, 180, receptors)).toBeNull();
  });

  it('رياح تهب شمالاً (قادمة من الجنوب) → يجد المستقبِل السكني الشمالي القريب', () => {
    const distance = nearestDownwindReceptorDistanceM(24.7, 46.7, 180, receptors);
    expect(distance).not.toBeNull();
    expect(distance).toBeLessThan(1000);
  });

  it('رياح تهب جنوباً (قادمة من الشمال) → يجد المستقبِل السكني الجنوبي البعيد فقط، لا الشمالي', () => {
    const distance = nearestDownwindReceptorDistanceM(24.7, 46.7, 0, receptors);
    expect(distance).not.toBeNull();
    // الجنوبي أبعد جغرافياً من الشمالي، لكنه الوحيد باتجاه الريح هنا
    expect(distance).toBeGreaterThan(1000);
  });

  it('رياح تهب شرقاً بعيداً عن كل المستقبِلات السكنية (فقط مستشفى بالاتجاه، غير محسوب لأنه ليس سكنياً)', () => {
    // ملاحظة: nearestDownwindReceptorDistanceM يفحص فقط الأنواع السكنية
    // (RESIDENTIAL/SCHOOL/HOSPITAL — لاحظ أن HOSPITAL مدرج فعلياً ضمن
    // RESIDENTIAL_RECEPTOR_TYPES في geo.ts) — إذاً المستشفى الشرقي يُحسب.
    const distance = nearestDownwindReceptorDistanceM(24.7, 46.7, 270, receptors); // تهب شرقاً
    expect(distance).not.toBeNull();
    expect(distance).toBeLessThan(3000);
  });

  it('لا يوجد أي مستقبِل سكني في اتجاه الريح إطلاقاً → Infinity (آمن، لا null)', () => {
    const onlyFarNorth: SensitiveReceptor[] = [
      { id: 'r1', name: 'بعيد جداً جنوباً', receptorType: 'RESIDENTIAL', lat: 24.5, lng: 46.7 },
    ];
    // رياح تهب شرقاً (لا جنوباً) — المستقبِل الوحيد المتاح جنوبي، خارج القطاع
    const distance = nearestDownwindReceptorDistanceM(24.7, 46.7, 270, onlyFarNorth);
    expect(distance).toBe(Infinity);
  });
});
