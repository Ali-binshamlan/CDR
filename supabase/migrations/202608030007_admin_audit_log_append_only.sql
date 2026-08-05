-- =====================================================================
-- DCR — 202608030007_admin_audit_log_append_only.sql
-- =====================================================================
-- خطأ أمني مكتشَف — مراجعة كود خبير خارجي: "admin_audit_log ليس append-only
-- بالكامل". الجدول (راجع 202607290001_baseline_final.sql) مفعَّل عليه RLS
-- لكن بلا أي سياسة صراحة ("عمداً بلا أي سياسة RLS — service_role فقط") —
-- هذا يمنع anon/authenticated فقط؛ RLS لا تُطبَّق على service_role إطلاقاً
-- (نفس النقطة الموثَّقة في 202607290004_append_only_audit.sql لجداول
-- الأدلة الأخرى)، فلا شيء كان يمنع كود يستخدم supabaseAdmin (service_role)
-- من UPDATE/DELETE على سجلات تدقيق سابقة — يُفسِد قيمة الجدول كدليل تدقيق
-- موثوق تماماً لو حدث خطأ برمجي مستقبلي أو استعلام يدوي غير مقصود.
--
-- الإصلاح: نفس trigger forbid_evidence_mutation() المُستخدَم أصلاً لجداول
-- الأدلة (decision_records/dust_evaluations/dust_compliance_evaluations/
-- pm10_readings_history/alert_state_events) — admin_audit_log لا يملك أي
-- عمود يحتاج استثناء (لا dust_profile_id هنا)، فالشرط الوحيد المسموح في
-- تلك الدالة (خاص بجدولي dust_evaluations/dust_compliance_evaluations
-- تحديداً) لن ينطبق عليه أصلاً — أي UPDATE أو DELETE يُرفَض بالكامل بلا
-- استثناء، وهو المطلوب بالضبط لسجل تدقيق.
-- =====================================================================

drop trigger if exists admin_audit_log_immutable on public.admin_audit_log;
create trigger admin_audit_log_immutable
  before update or delete on public.admin_audit_log
  for each row execute function public.forbid_evidence_mutation();
