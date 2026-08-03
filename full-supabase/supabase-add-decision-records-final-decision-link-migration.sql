-- =====================================================================
-- هجرة: ربط decision_records بقرار final_decisions الذي بُني عليه فعلياً
--
-- المشكلة المكتشفة (مراجعة كود خبير خارجي — C-08: "قرار المستخدم لا
-- يتحقق من القرار الإلزامي"): POST /api/decisions كان يسجّل قرار المستخدم
-- (اعتماد/تأجيل/تقييد/إيقاف) بلا أي رابطة صريحة بالقرار الآلي (final_decisions)
-- الذي كان معروضاً له لحظة اتخاذ القرار — فحتى بعد إضافة فحص الخادم (منع
-- تسجيل status غير 'stopped' فوق إيقاف إلزامي غير قابل للتجاوز)، يبقى سجل
-- decision_records غير قابل للتدقيق الكامل: أي قرار آلي بالضبط كان معروضاً
-- حين اتخذ المستخدم قراره؟
--
-- الإصلاح: عمود final_decision_id (مرجع اختياري لـfinal_decisions.id) —
-- يُملأ من الخادم عند الكتابة (لا من العميل)، يشير لآخر قرار آلي مخزَّن
-- لنفس activity_group_id لحظة اتخاذ القرار البشري. اختياري (nullable)
-- لأنشطة/مسارات لم تصل بعد لهذا الربط (مثال: أنشطة بلا final_decisions
-- مخزَّنة بعد)، أو لعدم كسر أي صف تاريخي موجود.
-- =====================================================================

alter table public.decision_records
  add column if not exists final_decision_id uuid references public.final_decisions(id) on delete set null;

create index if not exists idx_decision_records_final_decision_id
  on public.decision_records (final_decision_id);
