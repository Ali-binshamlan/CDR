// =============================================================
// AEI Engine — Tables & Constants
// =============================================================

import { ActivityCategory } from '../dust-engine/types';
import { AeiColor, AeiStatus } from './types';

// أنشطة تتأثر جودتها مباشرة بالغبار العالق (التصاق/تشطيب/طبقة نهائية)
export const DUST_QUALITY_SENSITIVE_ACTIVITIES: ActivityCategory[] = [
  'EXTERNAL_PAINTING',
  'COATING',
  'WATERPROOFING',
  'FACADE_INSTALLATION',
];

// السقف الإجباري لقيمة AEI عندما يكون قرار DVI في مرحلة تحذيرية/مقيدة
export const AEI_RESTRICT_CAP = 59;

// القرارات التي تفعّل السقف الإجباري (قرار DVI مقيّد لكنه ليس إيقافًا إلزاميًا)
export const AEI_CAPPING_DVI_DECISIONS = [
  'RESTRICT',
  'RESTRICT_SEVERE',
  'STOP_DUST_GENERATING_ACTIVITIES',
  'STOP_VISIBILITY_DEPENDENT_ACTIVITIES',
];

// دالة تحويل الدرجة الرقمية إلى حالة تشغيلية
export function aeiStatusFromScore(score: number): AeiStatus {
  if (score <= 0) return 'CLOSED';
  if (score <= 39) return 'RESTRICT';
  if (score <= 69) return 'MONITOR';
  return 'ALLOW';
}

// جدول ترجمة حالات مؤشر AEI إلى نصوص واضحة في الواجهة
export const AEI_STATUS_LABEL_AR: Record<AeiStatus, string> = {
  ALLOW: 'قابل للتنفيذ',
  MONITOR: 'قابل للتنفيذ مع مراقبة',
  RESTRICT: 'تقييد تشغيلي وضوابط إضافية',
  CLOSED: 'بيئة العمل غير آمنة (مغلق)',
};

// خريطة تحويل الحالة التشغيلية إلى اللون المناسب للـ UI
// تم توحيد الألوان: الأحمر للتقييد الشديد والأسود للإغلاق الإلزامي
export const AEI_COLOR_FROM_STATUS: Record<AeiStatus, AeiColor> = {
  ALLOW: 'GREEN',
  MONITOR: 'YELLOW',
  RESTRICT: 'RED', 
  CLOSED: 'BLACK',
};