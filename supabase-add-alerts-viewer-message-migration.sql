-- =====================================================================
-- هجرة: رسالة تنبيه رسمية منفصلة لجهة الرصد (account_role='viewer') —
-- عمود اختياري على alerts، يُملأ فقط لتنبيهات COMPLIANCE_VIOLATION (طلب
-- صريح من المستخدم)، بصياغة رسمية موحَّدة تخص جهة الرصد بدل النص التقني
-- الداخلي الموجَّه لصاحب المشروع (alerts.message).
--
-- null لأي تنبيه آخر (BEFORE_*/COMPLIANCE_RESTRICTION/ADVISORY/إلخ) — لا
-- حاجة لملء الحقل لتنبيه لن يعرضه أحد بصياغة مختلفة. راجع
-- app/api/alerts/generate/route.ts (بناء القيمة) وapp/api/admin/alerts/
-- route.ts (استبدال message بـviewer_message للطالب الفعلي عندما يكون
-- جهة رصد).
-- =====================================================================

alter table public.alerts
  add column if not exists viewer_message text;
