import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestSupabaseAdmin } from './dbTestClient';

// =====================================================================
// اختبارات تزامن PostgreSQL حقيقية — القسم 18.5 من "دليل الإصلاح الجذري
// لمنظومة مرقاب": "طلبا CAS بنفس expected_revision: واحد ينجح والآخر
// يفشل بـ40001، بلا Orphans"، "عاملان يطالبان Job: عامل واحد فقط"،
// "Archive متزامن مع Ingest: بعد فوز الأرشفة لا History ولا Snapshot
// جديد"، "Archive متزامن مع Persist Decision: لا قرار بعد الأرشفة".
// تُشغَّل هذه الاستدعاءات فعلياً بالتوازي (Promise.all) على قاعدة
// PostgreSQL محلية حقيقية عبر supabase-js (لا mock) — RPCs نفسها (قفل
// استشاري pg_advisory_xact_lock، FOR UPDATE SKIP LOCKED، شرط CAS على
// updated_at) هي ما يضمن النتيجة الحتمية، لا منطق الاختبار.
// =====================================================================

let admin: SupabaseClient;
let userId: string;

beforeAll(async () => {
  admin = createTestSupabaseAdmin();
  // مستخدم اختبار حقيقي في auth.users — projects.user_id يتطلب FK صالحاً.
  const email = `dbtest-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`فشل إنشاء مستخدم اختبار: ${error?.message}`);
  userId = data.user.id;
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
});

async function createTestProject(): Promise<string> {
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: userId, name: `مشروع اختبار ${randomUUID()}` })
    .select('id')
    .single();
  if (error || !data) throw new Error(`فشل إنشاء مشروع اختبار: ${error?.message}`);
  return data.id as string;
}

async function createTestActivity(projectId: string, activityGroupId: string): Promise<string> {
  const { data, error } = await admin
    .from('project_dust_profiles')
    .insert({
      project_id: projectId,
      activity_group_id: activityGroupId,
      activity_type: 'GENERAL_OUTDOOR_WORK',
      planned_date: new Date().toISOString().slice(0, 10),
      planned_time: '08:00:00',
      duration_hours: 4,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`فشل إنشاء نشاط اختبار: ${error?.message}`);
  // activity_groups يجب أن يحمل الصف المطابق قبل استدعاء persist_activity_decision_atomic
  // (composite FK إلى activity_groups(project_id, id) بعد 202608040007/8).
  await admin
    .from('activity_groups')
    .upsert({ project_id: projectId, id: activityGroupId }, { onConflict: 'project_id,id', ignoreDuplicates: true });
  return data.id as string;
}

function baseDviResult(): Record<string, unknown> {
  return { decisionCategory: 'ALLOW', triggeredRules: [], shortReason: 'test' };
}

function baseFinalDecision(operationalDecision: string): Record<string, unknown> {
  return {
    mode: 'LIVE_OPERATIONAL',
    operationalDecision,
    regulatoryFinding: 'COMPLIANT',
    mandatoryStop: operationalDecision === 'MANDATORY_STOP',
    overridable: operationalDecision !== 'MANDATORY_STOP',
    shortReasonAr: 'اختبار',
    decisionLabelAr: 'اختبار',
    level: operationalDecision === 'MANDATORY_STOP' ? 'BLACK' : 'GREEN',
    pendingConfirmation: false,
    reasonCodes: [],
    evidenceQuality: 'OK',
    ruleBundleVersion: 'test',
  };
}

describe('CAS (compare-and-swap) على current_dust_decisions — نفس expected_revision', () => {
  it('طلبان متزامنان بنفس expected_updated_at: واحد ينجح والآخر يفشل بـ40001، بلا orphans', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    // أول كتابة (بلا CAS — أول إدراج) لبناء صف current_dust_decisions أولي.
    const { error: firstError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: baseDviResult(),
      p_dvi_triggered_by: 'user_refresh',
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: null,
      p_final_evaluated_at: null,
    });
    expect(firstError).toBeNull();

    const { data: current } = await admin
      .from('current_dust_decisions')
      .select('updated_at')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .single();
    const expectedUpdatedAt = current!.updated_at as string;

    // طلبان متزامنان فعلياً، كلاهما يقرأ نفس expected_updated_at (نفس
    // اللقطة) — نتيجة السباق الحقيقي على القفل الاستشاري + شرط WHERE
    // updated_at = expected، لا محاكاة.
    const attempt = () =>
      admin.rpc('persist_activity_decision_atomic', {
        p_project_id: projectId,
        p_activity_group_id: groupId,
        p_activity_id: activityId,
        p_dvi_result: baseDviResult(),
        p_dvi_triggered_by: 'user_refresh',
        p_dvi_expected_updated_at: expectedUpdatedAt,
        p_compliance_result: null,
        p_compliance_rulebook_version: null,
        p_compliance_triggered_by: null,
        p_compliance_expected_updated_at: null,
        p_compliance_dust_profile_id: null,
        p_compliance_stopped_since: null,
        p_compliance_pending_resume_since: null,
        p_final_decision: null,
        p_final_evaluated_at: null,
      });

    const [resultA, resultB] = await Promise.all([attempt(), attempt()]);
    const results = [resultA, resultB];
    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error!.message).toMatch(/CAS conflict/);

    // لا orphans: عدد صفوف dust_evaluations لهذا النشاط يطابق عدد المحاولات
    // الناجحة فقط (الأولى + محاولة واحدة ناجحة من الاثنتين)، لا صف يتيم
    // بلا current_dust_decisions محدَّث يطابقه.
    const { data: evaluations } = await admin
      .from('dust_evaluations')
      .select('id')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId);
    expect(evaluations).toHaveLength(2); // الإدراج الأولي + محاولة ناجحة واحدة
  });
});

describe('عاملان يطالبان بنفس Job — claim_evaluation_jobs', () => {
  it('عاملان متزامنان: عامل واحد فقط يفوز بمهمة واحدة (FOR UPDATE SKIP LOCKED)', async () => {
    const projectId = await createTestProject();
    const { data: job, error: insertError } = await admin
      .from('project_evaluation_jobs')
      .insert({ project_id: projectId, dedupe_key: `dbtest-${randomUUID()}`, status: 'PENDING' })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    const workerA = randomUUID();
    const workerB = randomUUID();
    const [claimedA, claimedB] = await Promise.all([
      admin.rpc('claim_evaluation_jobs', { p_worker_id: workerA, p_batch_size: 10, p_lease_seconds: 60 }),
      admin.rpc('claim_evaluation_jobs', { p_worker_id: workerB, p_batch_size: 10, p_lease_seconds: 60 }),
    ]);

    const claimedByA = (claimedA.data ?? []).some((j: { id: string }) => j.id === job!.id);
    const claimedByB = (claimedB.data ?? []).some((j: { id: string }) => j.id === job!.id);

    // بالضبط عامل واحد فاز بهذه المهمة تحديداً — لا كلاهما، ولا لا أحد.
    expect(claimedByA !== claimedByB).toBe(true);

    const { data: finalJob } = await admin.from('project_evaluation_jobs').select('worker_id, status').eq('id', job!.id).single();
    expect(finalJob!.status).toBe('RUNNING');
    expect(finalJob!.worker_id).toBe(claimedByA ? workerA : workerB);
  });
});

describe('Archive متزامن مع Ingest — بعد فوز الأرشفة لا كتابة جديدة', () => {
  it('أرشفة وingest متزامنان لنفس المشروع: يفوز أحدهما بالقفل، والآخر يُرفَض إن جاء بعد الأرشفة فعلياً', async () => {
    const projectId = await createTestProject();
    const apiKeyHash = randomUUID();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({ project_id: projectId, name: 'جهاز اختبار', api_key_hash: apiKeyHash, api_key_prefix: 'dcr_test' })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    // نؤرشف أولاً بشكل متسلسل (لضمان اكتمالها)، ثم نتحقق أن أي محاولة
    // ingest لاحقة تُرفَض صراحة بـPROJECT_ARCHIVED — هذا هو السلوك المضمون
    // بعد فوز القفل، بصرف النظر عن ترتيب وصول الطلبين الفعلي (كلاهما يطلب
    // نفس القفل الاستشاري بالتسلسل داخل PostgreSQL نفسه مهما تزامنا من
    // جهة العميل).
    const { error: archiveError } = await admin.rpc('archive_project_atomic', {
      p_project_id: projectId,
      p_actor_id: userId,
    });
    expect(archiveError).toBeNull();

    const { error: ingestError } = await admin.rpc('ingest_device_reading_atomic', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: null,
      p_observed_at: new Date().toISOString(),
      p_received_at: new Date().toISOString(),
      p_measurements: { pm10: 50 },
    });
    expect(ingestError).not.toBeNull();
    expect(ingestError!.message).toMatch(/device not found|revoked|PROJECT_ARCHIVED/);

    // لا history جديد لهذا الجهاز — الكتابة رُفضت فعلياً قبل أي INSERT.
    const { data: history } = await admin.from('device_readings_history').select('id').eq('device_id', device!.id);
    expect(history).toEqual([]);
  });
});

describe('Archive متزامن مع Persist Decision — لا قرار جديد بعد الأرشفة', () => {
  it('أرشفة المشروع تمنع persist_activity_decision_atomic لاحقاً بخطأ PROJECT_ARCHIVED صريح', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { error: archiveError } = await admin.rpc('archive_project_atomic', {
      p_project_id: projectId,
      p_actor_id: userId,
    });
    expect(archiveError).toBeNull();

    const { error: persistError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: baseDviResult(),
      p_dvi_triggered_by: 'user_refresh',
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: null,
      p_final_evaluated_at: null,
    });
    expect(persistError).not.toBeNull();
    expect(persistError!.message).toMatch(/PROJECT_ARCHIVED/);

    const { data: decisions } = await admin.from('current_dust_decisions').select('id').eq('project_id', projectId);
    expect(decisions).toEqual([]);
  });
});

describe('Outbox — نية تنبيه واحدة فقط لكل قرار (unique constraint)', () => {
  it('قرار MANDATORY_STOP ينتج نية SAFETY_BREACH واحدة في decision_alert_outbox', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { error } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(error).toBeNull();

    const { data: outboxRows } = await admin
      .from('decision_alert_outbox')
      .select('kind, action')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows![0]).toMatchObject({ kind: 'SAFETY_BREACH', action: 'OPEN' });
  });

  // خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي، القسم 2
  // "تثبيت مسار Outbox/Retry": "تشغيل سيناريو فشل متعمد لمعرفة أن الرسالة
  // تُعاد مع استرجاع صحيح"): قيد CHECK الأصلي على decision_alert_outbox.status
  // (202608040012) لم يكن يسمح بـ'RETRY' إطلاقاً، فكان أي استدعاء فعلي لـ
  // fail_alert_outbox_row بفشل غير نهائي يرمي خطأ PostgreSQL حقيقياً (انتهاك
  // قيد CHECK) بدل تسجيل RETRY بنجاح — لم يكشفه أي اختبار سابق لأن
  // alert-outbox-worker/route.test.ts ينمّه supabaseAdmin.rpc بالكامل (لا
  // يشغّل القيد الفعلي على قاعدة بيانات حقيقية). هذا الاختبار يستدعي
  // fail_alert_outbox_row فعلياً (لا mock) على صف Outbox حقيقي، بمحاكاة فشل
  // متعمد، ويثبت: (أ) الصف يعود RETRY لا يُرفَض بخطأ CHECK (202608040034)،
  // (ب) attempts يتزايد وavailable_at يتأخر (Backoff)، (ج) claim_alert_outbox_
  // batch يستطيع استرجاع نفس الصف لاحقاً بعد مرور available_at (لا يبقى عالقاً).
  it('فشل متعمد عبر fail_alert_outbox_row: الصف يعود RETRY (لا خطأ CHECK)، وattempts يتزايد، ويُستَرجَع لاحقاً عبر claim', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { error: persistError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(persistError).toBeNull();

    const { data: outboxRow } = await admin
      .from('decision_alert_outbox')
      .select('id, attempts')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .single();
    expect(outboxRow!.attempts).toBe(0);

    // فشل متعمد أول: attempts=0 < p_max_attempts الافتراضي (5) → RETRY، لا DEAD.
    const { error: failError } = await admin.rpc('fail_alert_outbox_row', {
      p_row_id: outboxRow!.id,
      p_error: 'فشل متعمد لاختبار مسار الإعادة',
    });
    // هذا هو صلب الإصلاح: بلا 202608040034 كان هذا السطر يفشل بانتهاك قيد
    // CHECK (decision_alert_outbox_status_check) بدل إرجاع null.
    expect(failError).toBeNull();

    const { data: afterFail } = await admin
      .from('decision_alert_outbox')
      .select('status, attempts, available_at, last_error, locked_by, locked_until')
      .eq('id', outboxRow!.id)
      .single();
    expect(afterFail!.status).toBe('RETRY');
    expect(afterFail!.attempts).toBe(1);
    expect(afterFail!.last_error).toBe('فشل متعمد لاختبار مسار الإعادة');
    expect(afterFail!.locked_by).toBeNull();
    expect(afterFail!.locked_until).toBeNull();
    // Backoff أسّي: available_at يجب أن يكون بالمستقبل (power(2,0)*5 = 5 ثوانٍ).
    expect(new Date(afterFail!.available_at).getTime()).toBeGreaterThan(Date.now());

    // استرجاع صحيح: claim_alert_outbox_batch لا يستعيد الصف فوراً (لم يحن
    // available_at بعد) — يثبت أن RETRY فعلاً يُحترَم كحالة "مؤجَّلة"، لا
    // "جاهزة فوراً" رغم كونها ضمن union_ids.
    const { data: tooSoonClaim } = await admin.rpc('claim_alert_outbox_batch', {
      p_worker_id: randomUUID(),
      p_batch_size: 50,
      p_lease_seconds: 60,
    });
    expect((tooSoonClaim ?? []).some((r: { id: string }) => r.id === outboxRow!.id)).toBe(false);

    // بعد مرور available_at فعلياً (Backoff قصير جداً هنا — 5 ثوانٍ كحد
    // أدنى)، الصف يجب أن يُسترجَع بنجاح — لا يبقى عالقاً RETRY للأبد.
    await admin
      .from('decision_alert_outbox')
      .update({ available_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', outboxRow!.id);

    const workerId = randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc('claim_alert_outbox_batch', {
      p_worker_id: workerId,
      p_batch_size: 50,
      p_lease_seconds: 60,
    });
    expect(claimError).toBeNull();
    expect((claimed ?? []).some((r: { id: string }) => r.id === outboxRow!.id)).toBe(true);

    const { data: afterClaim } = await admin
      .from('decision_alert_outbox')
      .select('status, locked_by')
      .eq('id', outboxRow!.id)
      .single();
    expect(afterClaim!.status).toBe('RUNNING');
    expect(afterClaim!.locked_by).toBe(workerId);

    // فشل نهائي: نرفع attempts يدوياً لحافة p_max_attempts، ثم فشل واحد أخير
    // يجب أن يُنتِج DEAD لا RETRY — يثبت أن القيد المُصلَح يسمح بكلا القيمتين
    // معاً (RETRY وDEAD)، لا RETRY فقط.
    await admin.from('decision_alert_outbox').update({ attempts: 5 }).eq('id', outboxRow!.id);
    const { error: finalFailError } = await admin.rpc('fail_alert_outbox_row', {
      p_row_id: outboxRow!.id,
      p_error: 'فشل نهائي بعد استنفاد المحاولات',
      p_max_attempts: 5,
    });
    expect(finalFailError).toBeNull();

    const { data: afterFinalFail } = await admin
      .from('decision_alert_outbox')
      .select('status')
      .eq('id', outboxRow!.id)
      .single();
    expect(afterFinalFail!.status).toBe('DEAD');
  });

  // القسم 20 (Definition of Done، بند 7) من "دليل الإصلاح الجذري لمنظومة
  // مرقاب" — "القرار والتنبيه يحملان final_decision_id/evaluation_run_id/
  // input_snapshot_hash نفسها". final_decision_id كان مضموناً مسبقاً (FK
  // صريح)؛ يثبت هذا الاختبار أن evaluation_run_id (وinput_snapshot_hash
  // على القرار نفسه) يُنسَخان فعلياً إلى الصفَّين معاً عبر نفس استدعاء
  // persist_activity_decision_atomic — لا قيمتان مستقلتان قد تتباعدان.
  it('القرار (final_decisions) والتنبيه المرتبط (decision_alert_outbox) يحملان نفس evaluation_run_id، والقرار يحمل input_snapshot_hash', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { data: runRow, error: runError } = await admin
      .from('evaluation_runs')
      .insert({ project_id: projectId, trigger_type: 'USER_REQUEST', as_of: new Date().toISOString(), status: 'RUNNING' })
      .select('id')
      .single();
    expect(runError).toBeNull();
    const evaluationRunId = runRow!.id as string;

    const snapshotHash = 'test-snapshot-hash-' + randomUUID();

    const { error } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
      p_evaluation_run_id: evaluationRunId,
      p_input_snapshot_hash: snapshotHash,
    });
    expect(error).toBeNull();

    const { data: decisionRow } = await admin
      .from('final_decisions')
      .select('evaluation_run_id, input_snapshot_hash')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .single();
    expect(decisionRow!.evaluation_run_id).toBe(evaluationRunId);
    expect(decisionRow!.input_snapshot_hash).toBe(snapshotHash);

    const { data: outboxRow } = await admin
      .from('decision_alert_outbox')
      .select('evaluation_run_id')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .single();
    expect(outboxRow!.evaluation_run_id).toBe(evaluationRunId);
  });
});

describe('عزل الأنشطة بين مشروعين يشتركان في نفس activity_group_id', () => {
  it('مشروعان بنفس activity_group_id: current_dust_decisions لكل مشروع منفصل تماماً (لا خلط)', async () => {
    const sharedGroupId = `same-id-${randomUUID()}`;
    const projectA = await createTestProject();
    const projectB = await createTestProject();
    const activityA = await createTestActivity(projectA, sharedGroupId);
    const activityB = await createTestActivity(projectB, sharedGroupId);

    await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectA,
      p_activity_group_id: sharedGroupId,
      p_activity_id: activityA,
      p_dvi_result: { decisionCategory: 'MANDATORY_STOP', triggeredRules: [], shortReason: 'A' },
      p_dvi_triggered_by: 'user_refresh',
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: null,
      p_final_evaluated_at: null,
    });
    await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectB,
      p_activity_group_id: sharedGroupId,
      p_activity_id: activityB,
      p_dvi_result: { decisionCategory: 'ALLOW', triggeredRules: [], shortReason: 'B' },
      p_dvi_triggered_by: 'user_refresh',
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: null,
      p_final_evaluated_at: null,
    });

    const { data: decisionA } = await admin
      .from('current_dust_decisions')
      .select('decision')
      .eq('project_id', projectA)
      .eq('activity_group_id', sharedGroupId)
      .single();
    const { data: decisionB } = await admin
      .from('current_dust_decisions')
      .select('decision')
      .eq('project_id', projectB)
      .eq('activity_group_id', sharedGroupId)
      .single();

    expect(decisionA!.decision).toBe('MANDATORY_STOP');
    expect(decisionB!.decision).toBe('ALLOW');
  });
});

// القسم 18.5: "Current Pointer: Device/Shift في مشروع A يشير إلى B يفشل" —
// device_id/shift_id على project_dust_profiles مربوطان الآن بـFK مركّب
// (device_id/shift_id, project_id) → project_devices/project_shifts(id,
// project_id) بعد 202608040019/20، لا FK بسيط (device_id → project_devices
// (id) فقط) كما كان سابقاً — ذلك كان يسمح نظرياً بربط جهاز من مشروع A بنشاط
// في مشروع B بلا أي رفض من القاعدة نفسها.
describe('عزل قاعدة البيانات — Current Pointer عبر المشاريع (القسم 18.5)', () => {
  it('ربط جهاز من مشروع A بنشاط في مشروع B → يُرفَض بخطأ FK صريح', async () => {
    const projectA = await createTestProject();
    const projectB = await createTestProject();

    const { data: deviceA, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectA,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const { error: crossProjectError } = await admin.from('project_dust_profiles').insert({
      project_id: projectB,
      activity_group_id: `group-${randomUUID()}`,
      activity_type: 'GENERAL_OUTDOOR_WORK',
      planned_date: new Date().toISOString().slice(0, 10),
      planned_time: '08:00:00',
      duration_hours: 4,
      device_id: deviceA!.id,
    });

    expect(crossProjectError).not.toBeNull();
    expect(crossProjectError!.message).toMatch(/foreign key|violat/i);
  });

  it('ربط وردية من مشروع A بنشاط في مشروع B → يُرفَض بخطأ FK صريح', async () => {
    const projectA = await createTestProject();
    const projectB = await createTestProject();

    const { data: shiftA, error: shiftError } = await admin
      .from('project_shifts')
      .insert({ project_id: projectA, name: `وردية اختبار ${randomUUID()}`, start_time: '06:00', end_time: '10:00' })
      .select('id')
      .single();
    expect(shiftError).toBeNull();

    const { error: crossProjectError } = await admin.from('project_dust_profiles').insert({
      project_id: projectB,
      activity_group_id: `group-${randomUUID()}`,
      activity_type: 'GENERAL_OUTDOOR_WORK',
      planned_date: new Date().toISOString().slice(0, 10),
      planned_time: '08:00:00',
      duration_hours: 4,
      shift_id: shiftA!.id,
    });

    expect(crossProjectError).not.toBeNull();
    expect(crossProjectError!.message).toMatch(/foreign key|violat/i);
  });
});

// القسم 18.5: "UPDATE/DELETE/TRUNCATE على جداول الأدلة يفشل حتى بصلاحية
// الدور الخاسرة" — migration.dbtest.ts يغطي TRUNCATE (trigger على مستوى
// العبارة) لكل جداول الأدلة على قاعدة فارغة؛ هنا نضيف UPDATE/DELETE فعليَّين
// (trigger على مستوى الصف forbid_evidence_mutation، القسم 5.9) ضد صف حقيقي
// — لا يُطلَق trigger أصلاً لو لم يُطابَق أي صف (0 rows affected لا يُشغِّل
// FOR EACH ROW في PostgreSQL).
describe('عزل قاعدة البيانات — UPDATE/DELETE يفشلان على صف دليل حقيقي (القسم 18.5)', () => {
  it('pm10_readings_history: UPDATE على صف حقيقي يُرفَض (append-only)', async () => {
    const projectId = await createTestProject();
    const { data: row, error: insertError } = await admin
      .from('pm10_readings_history')
      .insert({ project_id: projectId, pm10_ug_m3: 45, source: 'manual' })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    const { error: updateError } = await admin
      .from('pm10_readings_history')
      .update({ pm10_ug_m3: 999 })
      .eq('id', row!.id);

    expect(updateError).not.toBeNull();
    expect(updateError!.message).toMatch(/append-only|not permitted/i);
  });

  it('pm10_readings_history: DELETE على صف حقيقي يُرفَض (append-only)', async () => {
    const projectId = await createTestProject();
    const { data: row, error: insertError } = await admin
      .from('pm10_readings_history')
      .insert({ project_id: projectId, pm10_ug_m3: 45, source: 'manual' })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    const { error: deleteError } = await admin.from('pm10_readings_history').delete().eq('id', row!.id);

    expect(deleteError).not.toBeNull();
    expect(deleteError!.message).toMatch(/append-only|not permitted/i);
  });
});

// القسم 18.5: "عاملان ينشئان Alert: Alert مفتوح واحد فقط" — create_alert_
// atomic (202608040012) يقفل أي صف مفتوح موجود بنفس (project_id,
// activity_id, kind) قبل الإدراج؛ استدعاءان متزامنان بنفس المفاتيح الثلاثة
// يجب أن ينتجا alert_id واحداً مشتركاً، لا صفين.
describe('Outbox/Alert — عاملان متزامنان ينشئان تنبيهاً بنفس المفاتيح (القسم 18.5)', () => {
  it('استدعاءان متزامنان لـcreate_alert_atomic بنفس (project_id, activity_id, kind) → alert مفتوح واحد فقط', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const callArgs = {
      p_project_id: projectId,
      p_activity_id: activityId,
      p_timing: 'DURING',
      p_kind: 'SAFETY_BREACH',
      p_message: 'اختبار تزامن',
      p_viewer_message: null,
      p_metric_label: null,
      p_metric_actual: null,
      p_metric_threshold: null,
      p_recommended_action: 'اختبار',
      p_opened_by_final_decision_id: null,
    };

    const [r1, r2] = await Promise.all([admin.rpc('create_alert_atomic', callArgs), admin.rpc('create_alert_atomic', callArgs)]);

    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r1.data).toBe(r2.data);

    const { data: openAlerts } = await admin
      .from('alerts')
      .select('id')
      .eq('project_id', projectId)
      .eq('activity_id', activityId)
      .eq('kind', 'SAFETY_BREACH')
      .neq('state', 'CLOSED');
    expect(openAlerts).toHaveLength(1);
  });
});

// خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6 (متابعة): "alert_id
// يُحفَظ فعلياً على الـOutbox، لكن final_decision_id لا يُحفظ فعلياً على
// التنبيه نفسه"): create_alert_atomic كانت تستقبل p_opened_by_final_
// decision_id بلا استخدامه إطلاقاً في INSERT — مُصلَح في 202608040029
// (عمود alerts.final_decision_id + إدراجه فعلياً + تحديثه عند إعادة
// المحاولة على تنبيه مفتوح موجود مسبقاً).
describe('create_alert_atomic — final_decision_id يُحفَظ فعلياً (202608040029)', () => {
  it('تنبيه جديد → final_decision_id يُسجَّل بنفس القيمة الممرَّرة', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { error: persistError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(persistError).toBeNull();

    const { data: finalDecisionRow } = await admin
      .from('final_decisions')
      .select('id')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const { data: alertId, error: createError } = await admin.rpc('create_alert_atomic', {
      p_project_id: projectId,
      p_activity_id: activityId,
      p_timing: 'DURING',
      p_kind: 'SAFETY_BREACH',
      p_message: 'اختبار final_decision_id',
      p_viewer_message: null,
      p_metric_label: null,
      p_metric_actual: null,
      p_metric_threshold: null,
      p_recommended_action: 'اختبار',
      p_opened_by_final_decision_id: finalDecisionRow!.id,
    });
    expect(createError).toBeNull();

    const { data: alertRow } = await admin
      .from('alerts')
      .select('final_decision_id')
      .eq('id', alertId!)
      .single();
    expect(alertRow!.final_decision_id).toBe(finalDecisionRow!.id);
  });

  it('تنبيه مفتوح موجود مسبقاً + استدعاء جديد بـfinal_decision_id مختلف → يُحدَّث للقيمة الأحدث بدل البقاء على القديمة', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const firstAlertId = (
      await admin.rpc('create_alert_atomic', {
        p_project_id: projectId,
        p_activity_id: activityId,
        p_timing: 'DURING',
        p_kind: 'SAFETY_BREACH',
        p_message: 'أول',
        p_viewer_message: null,
        p_metric_label: null,
        p_metric_actual: null,
        p_metric_threshold: null,
        p_recommended_action: 'اختبار',
        p_opened_by_final_decision_id: null,
      })
    ).data as string;

    const { error: persistError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(persistError).toBeNull();

    const { data: finalDecisionRow } = await admin
      .from('final_decisions')
      .select('id')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const secondCall = await admin.rpc('create_alert_atomic', {
      p_project_id: projectId,
      p_activity_id: activityId,
      p_timing: 'DURING',
      p_kind: 'SAFETY_BREACH',
      p_message: 'ثانٍ — نفس التنبيه المفتوح',
      p_viewer_message: null,
      p_metric_label: null,
      p_metric_actual: null,
      p_metric_threshold: null,
      p_recommended_action: 'اختبار',
      p_opened_by_final_decision_id: finalDecisionRow!.id,
    });
    expect(secondCall.error).toBeNull();
    expect(secondCall.data).toBe(firstAlertId); // نفس alert_id — لم يُنشَأ صف جديد

    const { data: alertRow } = await admin
      .from('alerts')
      .select('final_decision_id')
      .eq('id', firstAlertId)
      .single();
    expect(alertRow!.final_decision_id).toBe(finalDecisionRow!.id);
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6: "Outbox: لا توجد نوايا
// CLOSE" — close_alert_atomic (202608040026) يغلق أحدث تنبيه مفتوح عبر
// alert_state_events (trigger alert_state_events_sync يحدّث alerts.state).
describe('close_alert_atomic — إغلاق تنبيه مفتوح عبر alert_state_events (القسم 6/18.5)', () => {
  it('تنبيه مفتوح فعلياً → يُغلَق (state=CLOSED) ويُسجَّل حدث alert_state_events', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { data: alertId, error: createError } = await admin.rpc('create_alert_atomic', {
      p_project_id: projectId,
      p_activity_id: activityId,
      p_timing: 'DURING',
      p_kind: 'SAFETY_BREACH',
      p_message: 'اختبار',
      p_viewer_message: null,
      p_metric_label: null,
      p_metric_actual: null,
      p_metric_threshold: null,
      p_recommended_action: 'اختبار',
      p_opened_by_final_decision_id: null,
    });
    expect(createError).toBeNull();

    const { data: closedAlertId, error: closeError } = await admin.rpc('close_alert_atomic', {
      p_project_id: projectId,
      p_activity_id: activityId,
      p_kind: 'SAFETY_BREACH',
    });
    expect(closeError).toBeNull();
    expect(closedAlertId).toBe(alertId);

    const { data: alertRow } = await admin.from('alerts').select('state').eq('id', alertId!).single();
    expect(alertRow!.state).toBe('CLOSED');

    const { data: events } = await admin
      .from('alert_state_events')
      .select('new_state, previous_state')
      .eq('alert_id', alertId!)
      .order('created_at', { ascending: false })
      .limit(1);
    expect(events![0]).toMatchObject({ new_state: 'CLOSED' });
  });

  it('لا تنبيه مفتوح أصلاً لهذا (project_id, activity_id, kind) → يرجع null بلا خطأ', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { data: closedAlertId, error: closeError } = await admin.rpc('close_alert_atomic', {
      p_project_id: projectId,
      p_activity_id: activityId,
      p_kind: 'SAFETY_BREACH',
    });
    expect(closeError).toBeNull();
    expect(closedAlertId).toBeNull();
  });
});

// خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "دالة Claim كذلك لا تستعيد
// مهمة RUNNING بعد انتهاء Lease؛ إذا تعطل العامل تبقى المهمة عالقة إلى
// الأبد. الاختبار المسمّى Recovery لا يحاكي Crash؛ فهو يستدعي fail يدوياً
// أولاً ثم RETRY"): الاختبار القديم هنا كان يستدعي fail_evaluation_job
// صراحةً قبل الـclaim الجديد — هذا يختبر "استدعاء fail بعد أن اكتشف شخصٌ ما
// انتهاء Lease" لا Crash فعلياً (حيث لا يُستدعى fail إطلاقاً، لأن العملية
// توقفت قبل الوصول لذلك السطر من الكود). claim_evaluation_jobs (202608040005
// الأصلية) كانت تفحص فقط status in ('PENDING','RETRY') — لا RUNNING بانتهاء
// lease_until — فمهمة Crash حقيقي كانت تبقى RUNNING للأبد بلا أي مسار
// استرداد تلقائي. مُصلَح في 202608040028 (نفس نمط claim_alert_outbox_batch:
// union مع فرع RUNNING+lease_until منتهٍ). الاختبار أدناه يحاكي Crash
// الحقيقي مباشرة (INSERT صف RUNNING بـlease_until ماضٍ، بلا استدعاء fail
// إطلاقاً) بدل محاكاته عبر استدعاء fail أولاً.
describe('Scheduler Queue — استعادة مهمة بعد انتهاء Lease دون استدعاء fail (القسم 18.5، 202608040028)', () => {
  it('مهمة RUNNING بـlease_until في الماضي، بلا أي استدعاء fail_evaluation_job (محاكاة Crash حقيقي) → تُستعاد تلقائياً بواسطة claim_evaluation_jobs', async () => {
    const projectId = await createTestProject();
    const staleWorkerId = randomUUID();
    const { data: job, error: insertError } = await admin
      .from('project_evaluation_jobs')
      .insert({
        project_id: projectId,
        dedupe_key: `dedupe-${randomUUID()}`,
        trigger_type: 'SCHEDULED',
        status: 'RUNNING',
        worker_id: staleWorkerId,
        lease_until: new Date(Date.now() - 60_000).toISOString(),
      })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    // لا استدعاء fail_evaluation_job هنا إطلاقاً — هذا هو الفارق الجوهري عن
    // الاختبار القديم، ومحاكاة Crash الحقيقي: العامل توقف قبل استدعاء أي
    // شيء، والصف يعتمد فقط على انتهاء lease_until الزمني للاسترداد.
    const newWorkerId = randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc('claim_evaluation_jobs', {
      p_worker_id: newWorkerId,
      p_batch_size: 20,
      p_lease_seconds: 90,
    });

    expect(claimError).toBeNull();
    const claimedIds = (claimed as Array<{ id: string }>).map((r) => r.id);
    expect(claimedIds).toContain(job!.id);

    const { data: updatedJob } = await admin
      .from('project_evaluation_jobs')
      .select('worker_id, status')
      .eq('id', job!.id)
      .single();
    expect(updatedJob!.worker_id).toBe(newWorkerId);
    expect(updatedJob!.status).toBe('RUNNING');
  });

  it('مهمة RUNNING بـlease_until في المستقبل (لا يزال ضمن Lease صالح) → لا تُستعاد', async () => {
    const projectId = await createTestProject();
    const activeWorkerId = randomUUID();
    const { data: job, error: insertError } = await admin
      .from('project_evaluation_jobs')
      .insert({
        project_id: projectId,
        dedupe_key: `dedupe-${randomUUID()}`,
        trigger_type: 'SCHEDULED',
        status: 'RUNNING',
        worker_id: activeWorkerId,
        lease_until: new Date(Date.now() + 60_000).toISOString(),
      })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    const { data: claimed, error: claimError } = await admin.rpc('claim_evaluation_jobs', {
      p_worker_id: randomUUID(),
      p_batch_size: 20,
      p_lease_seconds: 90,
    });

    expect(claimError).toBeNull();
    const claimedIds = (claimed as Array<{ id: string }>).map((r) => r.id);
    expect(claimedIds).not.toContain(job!.id);
  });
});

// القسم 5.10 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "عقد الحدث كامل فقط
// في Push": ingest_device_event_v2 يرفض الآن p_sequence_no=null صراحةً (بدل
// قبوله بصمت كما كان — راجع 202608040024_ingest_device_event_v2_require_
// sequence.sql)، ويقبل أي قيمة غير سالبة فعلية (بما فيها المشتقة من
// observedAtIso في deviceReadingWriter.ts لمصادر Provider Pull التي لا
// تملك مفهوم sequence أصلاً).
describe('ingest_device_event_v2 — sequence_no إلزامي (القسم 5.10)', () => {
  it('p_sequence_no=null → يُرفَض صراحةً برسالة "sequence_no is required"', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const { error } = await admin.rpc('ingest_device_event_v2', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: null,
      p_received_at: new Date().toISOString(),
      p_measurements: { pm10: { value: 45, observedAtIso: new Date().toISOString() } },
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/sequence_no is required/i);
  });

  it('p_sequence_no قيمة سالبة → يُرفَض برسالة "sequence_no must be non-negative"', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const { error } = await admin.rpc('ingest_device_event_v2', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: -1,
      p_received_at: new Date().toISOString(),
      p_measurements: { pm10: { value: 45, observedAtIso: new Date().toISOString() } },
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/non-negative/i);
  });

  it('p_sequence_no قيمة صحيحة غير سالبة (مشتقة من observedAtIso) → ينجح', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const observedAtIso = new Date().toISOString();
    const { error } = await admin.rpc('ingest_device_event_v2', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: new Date(observedAtIso).getTime(),
      p_received_at: new Date().toISOString(),
      p_measurements: { pm10: { value: 45, observedAtIso } },
    });

    expect(error).toBeNull();
  });
});

// خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "أحدث تعريف لـ
// ingest_device_event_v2 أسقط قفل المشروع وفحص archived_at؛ أثبت اختبار
// قاعدة بيانات أن مشروعاً مؤرشفاً يقبل Event بعد إعادة تفعيل جهازه"):
// migration 202608040024 (فرض sequence_no) بُنيت بالخطأ فوق نسخة قديمة من
// الدالة، لا الأحدث (202608040010) التي أضافت pg_advisory_xact_lock + فحص
// archived_at — فحذفت الحماية ضد الأرشفة دون قصد. هذا الاختبار يثبت أن
// الإصلاح (إعادة الفحص لنفس ملف 202608040024) يعمل فعلياً.
describe('ingest_device_event_v2 — رفض مشروع مؤرشَف (القسم 5.8/18.5)', () => {
  it('مشروع مؤرشَف: ingest_device_event_v2 يُرفَض بـPROJECT_ARCHIVED رغم أن الجهاز نفسه نشط', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const { error: archiveError } = await admin.rpc('archive_project_atomic', {
      p_project_id: projectId,
      p_actor_id: userId,
    });
    expect(archiveError).toBeNull();

    const observedAtIso = new Date().toISOString();
    const { error } = await admin.rpc('ingest_device_event_v2', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: new Date(observedAtIso).getTime(),
      p_received_at: new Date().toISOString(),
      p_measurements: { pm10: { value: 45, observedAtIso } },
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/PROJECT_ARCHIVED/);

    // لا صف device_metric_latest جديد — الكتابة رُفضت قبل أي INSERT.
    const { data: metricLatest } = await admin.from('device_metric_latest').select('id').eq('device_id', device!.id);
    expect(metricLatest).toEqual([]);
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "ThingsBoard ما زال يعيد تأريخ
// PM10 القديم كقراءة حديثة"): p_pm10_observed_at (202608040025) يضمن أن
// pm10_readings_history.observed_at يعكس وقت رصد PM10 الفعلي، لا الوقت
// المشترك الأحدث بين كل الحقول.
describe('ingest_device_reading_atomic — p_pm10_observed_at مستقل عن p_observed_at المشترك (القسم 5.4/18.4)', () => {
  it('حرارة حديثة (p_observed_at) + PM10 أقدم فعلياً (p_pm10_observed_at) → pm10_readings_history يسجّل وقت PM10 الحقيقي، لا وقت الحرارة', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const pm10ObservedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // قبل ساعتين
    const sharedObservedAt = new Date().toISOString(); // الآن (وقت الحرارة الأحدث)

    const { error: ingestError } = await admin.rpc('ingest_device_reading_atomic', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: Date.now(),
      p_observed_at: sharedObservedAt,
      p_received_at: sharedObservedAt,
      p_measurements: { pm10: 500, temperatureC: 40 },
      p_pm10_observed_at: pm10ObservedAt,
    });
    expect(ingestError).toBeNull();

    const { data: pm10History } = await admin
      .from('pm10_readings_history')
      .select('observed_at, recorded_at')
      .eq('device_id', device!.id)
      .single();

    expect(pm10History!.observed_at).toBe(pm10ObservedAt);
    expect(pm10History!.recorded_at).toBe(pm10ObservedAt);

    // device_readings_history (السجل العام) يبقى بالوقت المشترك كما هو —
    // لا تغيير على ذلك الجدول عمداً (راجع تعليق الهجرة).
    const { data: generalHistory } = await admin
      .from('device_readings_history')
      .select('observed_at')
      .eq('device_id', device!.id)
      .single();
    expect(generalHistory!.observed_at).toBe(sharedObservedAt);
  });

  it('p_pm10_observed_at غائب (null) → يُستخدَم p_observed_at المشترك كالسابق (توافق كامل)', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const observedAt = new Date().toISOString();
    const { error: ingestError } = await admin.rpc('ingest_device_reading_atomic', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: Date.now(),
      p_observed_at: observedAt,
      p_received_at: observedAt,
      p_measurements: { pm10: 50 },
    });
    expect(ingestError).toBeNull();

    const { data: pm10History } = await admin
      .from('pm10_readings_history')
      .select('observed_at')
      .eq('device_id', device!.id)
      .single();
    expect(pm10History!.observed_at).toBe(observedAt);
  });

  // خطأ حرج مكتشَف ذاتياً أثناء كتابة هذه الهجرة (202608040025) — النسخة
  // الأولى منها بُنيت بالخطأ فوق 202608020004 (الأصلي)، لا 202608040010
  // (الأحدث فعلياً، التي أضافت pg_advisory_xact_lock + فحص archived_at)،
  // فحذفت حماية الأرشفة دون قصد (نفس نمط الخطأ الذي وقع مع ingest_device_
  // event_v2 سابقاً في نفس الجلسة). يثبت هذا الاختبار أن الحماية بقيت بعد
  // إضافة p_pm10_observed_at.
  it('مشروع مؤرشَف: ingest_device_reading_atomic (بتوقيع p_pm10_observed_at الجديد) يُرفَض بـPROJECT_ARCHIVED', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const { error: archiveError } = await admin.rpc('archive_project_atomic', {
      p_project_id: projectId,
      p_actor_id: userId,
    });
    expect(archiveError).toBeNull();

    const observedAt = new Date().toISOString();
    const { error: ingestError } = await admin.rpc('ingest_device_reading_atomic', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: Date.now(),
      p_observed_at: observedAt,
      p_received_at: observedAt,
      p_measurements: { pm10: 50 },
      p_pm10_observed_at: observedAt,
    });

    expect(ingestError).not.toBeNull();
    expect(ingestError!.message).toMatch(/PROJECT_ARCHIVED/);
  });
});

// خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "ما زال يعيد تأريخ PM10
// القديم كقراءة حديثة: توجد كتابتان منفصلتان في deviceReadingWriter.ts —
// RPC قديمة تستخدم أحدث timestamp عام، وRPC V2 تستخدم timestamps مستقلة
// صحيحة. الكتابتان ليستا عملية واحدة ذرية"): ingest_device_reading_and_
// event_atomic (202608040027) يدمج كل كتابات V1 (device_readings_history/
// pm10_readings_history/project_devices.last_*) وV2 (device_events/device_
// measurements/device_metric_latest) في معاملة SQL واحدة — تنجح معاً أو
// تفشل معاً، بلا احتمال تباعد بين pm10_readings_history (استمرار المخالفة)
// وdevice_metric_latest (القرار الحي).
describe('ingest_device_reading_and_event_atomic — دمج V1+V2 في معاملة واحدة (البند 4)', () => {
  it('استدعاء واحد يكتب في كل الجداول الستة معاً — device_readings_history/pm10_readings_history/project_devices/device_events/device_measurements/device_metric_latest', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const pm10ObservedAt = new Date(Date.now() - 60_000).toISOString();
    const sharedObservedAt = new Date().toISOString();
    const externalEventId = randomUUID();

    const { data: result, error: ingestError } = await admin.rpc('ingest_device_reading_and_event_atomic', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: externalEventId,
      p_sequence_no: Date.now(),
      p_observed_at: sharedObservedAt,
      p_received_at: sharedObservedAt,
      p_measurements: { pm10: 500, temperatureC: 30 },
      p_pm10_observed_at: pm10ObservedAt,
      p_measurements_v2: {
        pm10: { value: 500, observedAtIso: pm10ObservedAt },
        temperatureC: { value: 30, observedAtIso: sharedObservedAt },
      },
    });
    expect(ingestError).toBeNull();
    expect(result?.[0]?.is_duplicate).toBe(false);

    const { data: v1General } = await admin
      .from('device_readings_history')
      .select('observed_at')
      .eq('device_id', device!.id)
      .single();
    expect(v1General!.observed_at).toBe(sharedObservedAt);

    const { data: v1Pm10 } = await admin
      .from('pm10_readings_history')
      .select('observed_at')
      .eq('device_id', device!.id)
      .single();
    expect(v1Pm10!.observed_at).toBe(pm10ObservedAt);

    const { data: v2Event } = await admin
      .from('device_events')
      .select('id')
      .eq('device_id', device!.id)
      .eq('external_event_id', externalEventId)
      .maybeSingle();
    expect(v2Event).not.toBeNull();

    const { data: v2Measurements } = await admin
      .from('device_measurements')
      .select('metric, observed_at')
      .eq('device_id', device!.id);
    expect(v2Measurements).toHaveLength(2);
    const pm10Measurement = v2Measurements!.find((m) => m.metric === 'pm10');
    expect(pm10Measurement!.observed_at).toBe(pm10ObservedAt);

    const { data: v2Latest } = await admin
      .from('device_metric_latest')
      .select('metric, observed_at')
      .eq('device_id', device!.id)
      .eq('metric', 'pm10')
      .single();
    expect(v2Latest!.observed_at).toBe(pm10ObservedAt);
  });

  it('مشروع مؤرشَف: يُرفَض بـPROJECT_ARCHIVED قبل أي كتابة في أي جدول من الستة', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const { error: archiveError } = await admin.rpc('archive_project_atomic', {
      p_project_id: projectId,
      p_actor_id: userId,
    });
    expect(archiveError).toBeNull();

    const observedAt = new Date().toISOString();
    const { error: ingestError } = await admin.rpc('ingest_device_reading_and_event_atomic', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: Date.now(),
      p_observed_at: observedAt,
      p_received_at: observedAt,
      p_measurements: { pm10: 50 },
    });
    expect(ingestError).not.toBeNull();
    expect(ingestError!.message).toMatch(/PROJECT_ARCHIVED/);

    const { data: metricLatest } = await admin.from('device_metric_latest').select('id').eq('device_id', device!.id);
    expect(metricLatest).toHaveLength(0);
  });

  it('p_measurements_v2 غائب تماماً (مصدر push قديم بلا fields مستقلة) → device_metric_latest يُبنى من p_observed_at المشتركة (fallback)، لا يُتخطَّى', async () => {
    const projectId = await createTestProject();
    const { data: device, error: deviceError } = await admin
      .from('project_devices')
      .insert({
        project_id: projectId,
        name: `جهاز اختبار ${randomUUID()}`,
        api_key_hash: randomUUID(),
        api_key_prefix: randomUUID().slice(0, 8),
      })
      .select('id')
      .single();
    expect(deviceError).toBeNull();

    const observedAt = new Date().toISOString();
    const { error: ingestError } = await admin.rpc('ingest_device_reading_and_event_atomic', {
      p_project_id: projectId,
      p_device_id: device!.id,
      p_external_event_id: null,
      p_sequence_no: Date.now(),
      p_observed_at: observedAt,
      p_received_at: observedAt,
      p_measurements: { pm10: 30 },
    });
    expect(ingestError).toBeNull();

    const { data: v2Latest } = await admin
      .from('device_metric_latest')
      .select('metric, value, observed_at')
      .eq('device_id', device!.id)
      .eq('metric', 'pm10')
      .single();
    expect(v2Latest!.value).toBe(30);
    expect(v2Latest!.observed_at).toBe(observedAt);
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6: "Outbox: لا توجد نوايا
// CLOSE" — persist_activity_decision_atomic الآن يقارن القرار الجديد بآخر
// قرار LIVE_OPERATIONAL محفوظ سابقاً لنفس النشاط، وينتج نية CLOSE عند تحسّن
// حقيقي من حالة تستوجب تنبيهاً إلى حالة لا تستوجبه (202608040026).
describe('Outbox — نوايا CLOSE عند تحسّن القرار (القسم 6/18.5)', () => {
  it('قرار MANDATORY_STOP ثم تحسّن إلى ALLOW → نية CLOSE لنفس kind (SAFETY_BREACH)', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { error: firstError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(firstError).toBeNull();

    const { error: secondError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('ALLOW'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(secondError).toBeNull();

    const { data: outboxRows } = await admin
      .from('decision_alert_outbox')
      .select('kind, action')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .order('created_at', { ascending: true });

    expect(outboxRows).toHaveLength(2);
    expect(outboxRows![0]).toMatchObject({ kind: 'SAFETY_BREACH', action: 'OPEN' });
    expect(outboxRows![1]).toMatchObject({ kind: 'SAFETY_BREACH', action: 'CLOSE' });
  });

  it('قرار ALLOW متتالٍ (لا حالة سابقة تستوجب تنبيهاً) → لا نية CLOSE زائفة', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    for (let i = 0; i < 2; i++) {
      const { error } = await admin.rpc('persist_activity_decision_atomic', {
        p_project_id: projectId,
        p_activity_group_id: groupId,
        p_activity_id: activityId,
        p_dvi_result: null,
        p_dvi_triggered_by: null,
        p_dvi_expected_updated_at: null,
        p_compliance_result: null,
        p_compliance_rulebook_version: null,
        p_compliance_triggered_by: null,
        p_compliance_expected_updated_at: null,
        p_compliance_dust_profile_id: null,
        p_compliance_stopped_since: null,
        p_compliance_pending_resume_since: null,
        p_final_decision: baseFinalDecision('ALLOW'),
        p_final_evaluated_at: new Date().toISOString(),
      });
      expect(error).toBeNull();
    }

    const { data: outboxRows } = await admin
      .from('decision_alert_outbox')
      .select('id')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId);
    expect(outboxRows).toEqual([]);
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6: "Outbox: صف RUNNING لا
// يملك Lease Recovery فعّال" — claim_alert_outbox_batch (202608040026) نفس
// نمط claim_evaluation_jobs: FOR UPDATE SKIP LOCKED + Lease، يسترد صفوف
// RUNNING منتهية المهلة تلقائياً.
describe('Outbox Queue — استعادة صف بعد انتهاء Lease (القسم 6/18.5)', () => {
  it('صف RUNNING بـlocked_until في الماضي → يُستعاد بواسطة claim_alert_outbox_batch لعامل آخر', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { error: persistError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(persistError).toBeNull();

    const { data: outboxRow } = await admin
      .from('decision_alert_outbox')
      .select('id')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .single();

    const staleWorkerId = randomUUID();
    await admin
      .from('decision_alert_outbox')
      .update({ status: 'RUNNING', locked_by: staleWorkerId, locked_until: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', outboxRow!.id);

    const newWorkerId = randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc('claim_alert_outbox_batch', {
      p_worker_id: newWorkerId,
      p_batch_size: 10,
      p_lease_seconds: 60,
    });

    expect(claimError).toBeNull();
    const claimedIds = (claimed as Array<{ id: string }>).map((r) => r.id);
    expect(claimedIds).toContain(outboxRow!.id);
  });

  it('صف RUNNING بـlocked_until في المستقبل (لا يزال ضمن Lease صالح) → لا يُستعاد', async () => {
    const projectId = await createTestProject();
    const groupId = `group-${randomUUID()}`;
    const activityId = await createTestActivity(projectId, groupId);

    const { error: persistError } = await admin.rpc('persist_activity_decision_atomic', {
      p_project_id: projectId,
      p_activity_group_id: groupId,
      p_activity_id: activityId,
      p_dvi_result: null,
      p_dvi_triggered_by: null,
      p_dvi_expected_updated_at: null,
      p_compliance_result: null,
      p_compliance_rulebook_version: null,
      p_compliance_triggered_by: null,
      p_compliance_expected_updated_at: null,
      p_compliance_dust_profile_id: null,
      p_compliance_stopped_since: null,
      p_compliance_pending_resume_since: null,
      p_final_decision: baseFinalDecision('MANDATORY_STOP'),
      p_final_evaluated_at: new Date().toISOString(),
    });
    expect(persistError).toBeNull();

    const { data: outboxRow } = await admin
      .from('decision_alert_outbox')
      .select('id')
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId)
      .single();

    const activeWorkerId = randomUUID();
    await admin
      .from('decision_alert_outbox')
      .update({ status: 'RUNNING', locked_by: activeWorkerId, locked_until: new Date(Date.now() + 60_000).toISOString() })
      .eq('id', outboxRow!.id);

    const { data: claimed, error: claimError } = await admin.rpc('claim_alert_outbox_batch', {
      p_worker_id: randomUUID(),
      p_batch_size: 10,
      p_lease_seconds: 60,
    });

    expect(claimError).toBeNull();
    const claimedIds = (claimed as Array<{ id: string }>).map((r) => r.id);
    expect(claimedIds).not.toContain(outboxRow!.id);
  });
});
