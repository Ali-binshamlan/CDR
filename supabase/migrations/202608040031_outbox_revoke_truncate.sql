-- =====================================================================
-- DCR — 202608040031_outbox_revoke_truncate.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 7: "جداول Device Events
-- وMeasurements وOutbox ليست محمية بالكامل من TRUNCATE"):
--
-- device_events/device_measurements محميان فعلياً منذ 202608040014
-- (trigger BEFORE TRUNCATE FOR EACH STATEMENT + REVOKE TRUNCATE صريح).
-- لكن decision_alert_outbox (202608040012) لم يُدرَج في تلك القائمة إطلاقاً
-- — لا trigger، ولا REVOKE TRUNCATE صريح.
--
-- ملاحظة جوهرية: decision_alert_outbox ليس جدول أدلة append-only (يُحدَّث
-- عمداً بكثرة: status/attempts/locked_by/processed_at تتغيّر مع كل دورة
-- عامل) — فلا يجوز إضافته لـforbid_evidence_truncate/EVIDENCE_TABLES في
-- 202608040014 (ذاك يمنع UPDATE/DELETE أيضاً عبر trigger منفصل على مستوى
-- الصف، وهذا يكسر عمل الـworker تماماً). الإصلاح هنا مقصور عمداً على
-- TRUNCATE فقط — يمنع محو الطابور بالكامل بعبارة واحدة، بلا المساس بقدرة
-- الـworker على UPDATE الصفوف الفردية.
--
-- منح 202608040012 الأصلي (`grant select, insert, update ... to
-- service_role`) لم يشمل TRUNCATE أصلاً (GRANT قائمة سماح صريحة، لا صلاحية
-- ضمنية) — REVOKE هنا دفاع صريح إضافي (نفس فلسفة 202608040014: "لا تعتمد
-- سلامة الجدول على أن أحداً لم ينسَ سحب TRUNCATE يدوياً" لأي دور مستقبلي).
-- =====================================================================

create or replace function public.forbid_outbox_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'decision_alert_outbox cannot be truncated — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;

drop trigger if exists decision_alert_outbox_no_truncate on public.decision_alert_outbox;
create trigger decision_alert_outbox_no_truncate
  before truncate on public.decision_alert_outbox
  for each statement execute function public.forbid_outbox_truncate();

revoke truncate on public.decision_alert_outbox from anon, authenticated, service_role;
