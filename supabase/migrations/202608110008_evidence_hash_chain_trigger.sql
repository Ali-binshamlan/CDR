-- =====================================================================
-- DCR — 202608110008_evidence_hash_chain_trigger.sql
-- =====================================================================
-- يبني على 202608110007 (evidence_hash_ledger). trigger AFTER INSERT على
-- كل جدول أدلة يحسب row_hash بالكامل من جانب الخادم (digest(to_jsonb(NEW),
-- sha256)) — التطبيق لا يقدر يزوّره لأنه لا يُمرَّر من التطبيق إطلاقاً،
-- بخلاف input_snapshot_hash (dustEvaluation.ts) الذي يبقى بلا أي تعديل هنا
-- (غرض مختلف تماماً: إثبات تطابق القرار/التنبيه، لا سلامة الصف).
--
-- previous_hash/chain_hash يُبنيان بقفل صف الذيل (FOR UPDATE) على الدفتر
-- نفسه — يسلسل كل الإدراجات عبر الجداول العشرة معاً على ترتيب seq واحد،
-- يمنع بنيوياً أي احتمال لحلقتين تدّعيان نفس previous_hash تحت تزامن حقيقي.
--
-- AFTER INSERT فقط — لا تضارب إطلاقاً مع forbid_evidence_mutation/
-- forbid_evidence_truncate (BEFORE UPDATE/DELETE/TRUNCATE حصراً).
--
-- خطأ أمني مكتشَف ومُصلَح (نفس عائلة خطأ 202608110011 — "digest() does not
-- exist" حين search_path لا يشمل extensions): كانت هذه الدالة بلا أي
-- search_path صريح إطلاقاً، فتعتمد على search_path الافتراضي للدور وقت
-- التنفيذ الفعلي (لا وقت الإنشاء) — عرضة لخطأ "digest() غير موجودة" إن
-- تغيّر إعداد الدور لاحقاً، وأيضاً ثغرة schema hijacking نظرية (بلا تقييد
-- صريح). الآن search_path مقيَّد صراحة (pg_catalog, public, extensions) —
-- نفس نمط بقية دوال هذه البنية.
-- =====================================================================

create or replace function public.append_evidence_hash_link()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row_hash text;
  v_previous_hash text;
  v_chain_hash text;
  v_row_created_at timestamptz;
begin
  v_row_hash := encode(digest(to_jsonb(NEW)::text, 'sha256'), 'hex');

  -- دعم عام لكل الجداول العشرة بأعمدة توقيت مختلفة (created_at أو
  -- recorded_at) عبر jsonb->>'...' بدل NEW.field المباشر (يفشل في وقت
  -- الإنشاء لو العمود غير موجود في جدول معيّن).
  v_row_created_at := coalesce(
    (to_jsonb(NEW)->>'created_at')::timestamptz,
    (to_jsonb(NEW)->>'recorded_at')::timestamptz,
    now()
  );

  select chain_hash into v_previous_hash
  from public.evidence_hash_ledger
  order by seq desc
  limit 1
  for update;

  v_chain_hash := encode(digest(v_row_hash || v_previous_hash, 'sha256'), 'hex');

  insert into public.evidence_hash_ledger (
    source_table, source_row_id, row_created_at, row_hash, previous_hash, chain_hash
  )
  values (TG_TABLE_NAME, NEW.id, v_row_created_at, v_row_hash, v_previous_hash, v_chain_hash);

  return NEW;
end;
$$;

do $$
declare
  t text;
  evidence_tables text[] := array[
    'decision_records',
    'dust_evaluations',
    'dust_compliance_evaluations',
    'pm10_readings_history',
    'alert_state_events',
    'device_readings_history',
    'final_decisions',
    'admin_audit_log',
    'device_events',
    'device_measurements'
  ];
begin
  foreach t in array evidence_tables loop
    execute format('drop trigger if exists %I_hash_chain_append on public.%I;', t, t);
    execute format(
      'create trigger %I_hash_chain_append after insert on public.%I for each row execute function public.append_evidence_hash_link();',
      t, t
    );
  end loop;
end $$;
