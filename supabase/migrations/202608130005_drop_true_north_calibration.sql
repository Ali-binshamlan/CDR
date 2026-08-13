-- =====================================================================
-- DCR — 202608130005_drop_true_north_calibration.sql
-- =====================================================================
-- خطأ معماري مكتشَف ومُصلَح (طلب صريح من المستخدم — "معايرة الشمال الحقيقي
-- ونسخة المعايرة لا تُحفظان بالكامل داخل لقطة القرار... هذه الميزة ملغية،
-- احذفها تماماً"):
--
-- deviceTrueNorthCalibration (documented/deviationDeg) كانت تُستهلَك فقط
-- أثناء حساب crusherDownwindM (buildActivityComplianceProfile،
-- dust-compliance-engine/adapters.ts) لتصحيح اتجاه الرياح المستخدَم في
-- قاعدة MRQ-RECEPTOR-DOWNWIND-120 — لكن DustComplianceResult المُخزَّنة
-- فعلياً (dust_compliance_evaluations/final_decisions) لا تحمل أي حقل يوثّق
-- هل استُخدمت معايرة موثَّقة وقت اتخاذ القرار، ولا قيمة الانحراف الفعلية —
-- القيمة تُستهلَك وتُفقَد فوراً، بلا أي أثر قابل لإعادة الحساب لاحقاً
-- (Replay/تدقيق، نفس مبدأ H-07 الموثَّق في المشروع). ميزة غير مكتملة
-- (feature ناقصة، لا خطأ عابر) — القرار حذفها بالكامل بدل استثمار وقت في
-- إكمال حفظها ضمن لقطة القرار.
--
-- الحذف يشمل: 7 أعمدة معايرة على project_devices (202608060001) + العمود
-- القديم غير المستخدَم فعلياً على projects (202607290001) — كلاهما لم يعد
-- له أي مستهلك في الكود بعد هذه الهجرة.

alter table public.project_devices
  drop column if exists true_north_alignment_documented,
  drop column if exists true_north_alignment_type,
  drop column if exists true_north_verification_method,
  drop column if exists true_north_verified_by,
  drop column if exists true_north_verified_at,
  drop column if exists true_north_deviation_deg,
  drop column if exists true_north_evidence_url;

alter table public.projects
  drop column if exists true_north_alignment_documented;
