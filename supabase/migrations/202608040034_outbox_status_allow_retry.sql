-- =====================================================================
-- DCR — 202608040034_outbox_status_allow_retry.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي، القسم 2
-- "تثبيت مسار Outbox/Retry": "مراجعة مخطط جدول Outbox والتأكد أن حالة
-- RETRY موجودة ومسموحة في enum/constraints"): قيد CHECK الأصلي على
-- decision_alert_outbox.status (202608040012) كان
-- check (status in ('PENDING', 'RUNNING', 'PROCESSED', 'DEAD')) — لا يشمل
-- 'RETRY' إطلاقاً، بينما fail_alert_outbox_row (202608040026) تكتب صراحةً
-- status = 'RETRY' لأي فشل غير نهائي (attempts < p_max_attempts)، وأيضاً
-- claim_alert_outbox_batch (202608040026) تفحص status in ('PENDING',
-- 'RETRY') ضمن union_ids. كل استدعاء فعلي لـfail_alert_outbox_row في مسار
-- إعادة المحاولة (لا الفشل النهائي DEAD) كان سيرمي خطأ PostgreSQL حقيقياً
-- (انتهاك قيد CHECK) بدل تسجيل RETRY، فيتوقف مسار الفشل/الإعادة بصمت في
-- الإنتاج. لم يكشفه أي اختبار محلي لأن route.test.ts ينمّه supabaseAdmin.rpc
-- بالكامل (لا يشغّل القيد الفعلي)، ولا يوجد اختبار .dbtest.ts يستدعي
-- fail_alert_outbox_row على قاعدة بيانات حقيقية.
--
-- الإصلاح: إسقاط القيد المُسمّى تلقائياً (decision_alert_outbox_status_check،
-- الاسم الافتراضي لقيد CHECK عمودي بلا اسم صريح) وإعادة إنشائه شاملاً
-- 'RETRY'.
-- =====================================================================

alter table public.decision_alert_outbox
  drop constraint if exists decision_alert_outbox_status_check;

alter table public.decision_alert_outbox
  add constraint decision_alert_outbox_status_check
  check (status in ('PENDING', 'RUNNING', 'RETRY', 'PROCESSED', 'DEAD'));
