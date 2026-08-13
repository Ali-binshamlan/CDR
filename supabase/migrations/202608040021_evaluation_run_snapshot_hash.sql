-- =====================================================================
-- DCR — 202608040021_evaluation_run_snapshot_hash.sql
-- =====================================================================
-- القسم 20 (Definition of Done، بند 7) من "دليل الإصلاح الجذري لمنظومة
-- مرقاب" — "القرار والتنبيه يحملان final_decision_id/evaluation_run_id/
-- input_snapshot_hash نفسها". final_decion_id كان موجوداً بالفعل (FK صريح
-- على decision_alert_outbox منذ 202608040012/13) — evaluation_run_id
-- (الجدول evaluation_runs من 202608040004) وinput_snapshot_hash لم يكونا
-- موجودين إطلاقاً على final_decisions، فلا رابط فعلياً يثبت "أي دورة تقييم
-- بالضبط أنتجت هذا القرار، وبأي مدخلات بالضبط" غير التوقيت التقريبي
-- (evaluated_at) وحده.
--
-- input_snapshot_hash: بصمة (SHA-256، مُمرَّرة جاهزة من التطبيق لا محسوبة
-- هنا — القاعدة لا تعرف شكل FinalDecisionInput الكامل) لمدخلات decideFinal
-- الفعلية (dvi + compliance + mode) التي أنتجت هذا القرار بالضبط — تسمح
-- لاحقاً بإثبات "نفس المدخلات تنتج نفس القرار" (إعادة إنتاج/تدقيق) بلا
-- الحاجة لتخزين المدخلات الكاملة كنص خام مكرر (already مخزَّنة في
-- dust_evaluations/dust_compliance_evaluations كـjsonb منفصل).
-- =====================================================================

alter table public.final_decisions
  add column if not exists evaluation_run_id uuid references public.evaluation_runs(id) on delete set null,
  add column if not exists input_snapshot_hash text;

alter table public.decision_alert_outbox
  add column if not exists evaluation_run_id uuid references public.evaluation_runs(id) on delete set null;

create index if not exists idx_final_decisions_evaluation_run
  on public.final_decisions (evaluation_run_id);
