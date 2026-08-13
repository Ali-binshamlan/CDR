-- =====================================================================
-- DCR — 202608110002b_drop_stale_persist_decision_overload.sql
-- =====================================================================
-- خطأ حرج مكتشَف (فحص تحقق إلزامي قبل خطة "حزمة نشر ذرية لمعاملات القواعد
-- + حفظ معرّفات نسخها مع القرار"، 2026-08-10): استعلام مباشر على القاعدة
-- الحية (jwagoleclwiaavfuxexl) عبر pg_proc/pg_get_function_arguments أظهر
-- **توقيعين منفصلين فعلياً موجودين معاً** لـpersist_activity_decision_atomic:
--   oid 17885 — 15 معاملاً (ينتهي عند p_final_evaluated_at، بلا
--     p_evaluation_run_id/p_input_snapshot_hash) — التوقيع الأصلي من
--     202607290007/202608030005/202608030006/202608040011/202608040013،
--     قبل أن تضيف 202608040022 المعاملين الجديدين.
--   oid 18288 — 17 معاملاً (يتضمن p_evaluation_run_id uuid default null،
--     p_input_snapshot_hash text default null) — التوقيع الصحيح الحالي،
--     آخر مرة أُعيد تعريفه في 202608100001_final_decisions_state_change_skip.sql.
--
-- السبب: 202608040022_persist_decision_evaluation_run.sql رفع الدالة من 15
-- إلى 17 معاملاً عبر `create or replace function` **بلا** `drop function`
-- صريح للتوقيع القديم أولاً. في PostgreSQL، CREATE OR REPLACE FUNCTION
-- بعدد/نوع معاملات مختلف عن الموجود **لا يستبدل** الدالة القديمة — يُنشئ
-- Overload منفصلاً كلياً (نفس الاسم، توقيع مختلف = دالتان مستقلتان تماماً
-- من منظور Postgres). كل الهجرات اللاحقة (202608040026 وحتى 202608100001)
-- استخدمت create or replace function بنفس التوقيع 17-معاملاً فاستبدلت
-- جسم oid 18288 بأمان في كل مرة — لكن oid 17885 (15 معاملاً) بقي معلَّقاً
-- بجسمه القديم من قبل إضافة evaluation_run_id/input_snapshot_hash، قابلاً
-- للاستدعاء الفعلي حتى الآن لأي مستدعٍ (حالي أو مستقبلي) يمرر بالضبط 15
-- معاملاً موضعياً.
--
-- الأثر العملي: التطبيق الحالي (app/lib/dustEvaluation.ts) يستدعي الدالة
-- دائماً بأسماء معاملات صريحة (named arguments عبر supabase-js .rpc())
-- شاملة p_evaluation_run_id/p_input_snapshot_hash، فيستهدف حتماً oid 18288
-- الصحيح — لا عطل ملحوظ في الإنتاج حتى الآن. لكن bug كامن حقيقي: أي
-- استدعاء مستقبلي (سكربت اختبار، RPC مباشر، PostgREST caching state معيّن)
-- يمرر 15 معاملاً موضعياً فقط قد يُوجَّه لـoid 17885 القديم بصمت، فيُنتج
-- قراراً بلا evaluation_run_id/input_snapshot_hash بلا أي خطأ ظاهر.
--
-- الإصلاح: إسقاط صريح للتوقيع القديم (15 معاملاً) فقط — oid 18288 (17
-- معاملاً، الصحيح) لا يُمَس هنا إطلاقاً؛ الهجرة التالية (202608110006)
-- ستُعيد تعريفه بمعامل 18 لاحقاً بأمان بعد أن يتأكد وجود توقيع واحد فقط
-- الآن.
-- =====================================================================

drop function if exists public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz
);
