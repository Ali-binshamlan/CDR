import { describe, it, expect, vi, beforeEach } from 'vitest';

// =====================================================================
// اختبار قبول صريح (مراجعة كود خارجي — "المسار القديم للتنبيهات ينافس
// Outbox ويصنع قراءات PM10 وهمية"): تشغيل checkDustActivities عشر مرات
// متتالية يجب ألا يزيد عدد قراءات pm10_readings_history (كان يُدرِج
// onsite_pm10 الثابت بوقت جديد في كل تشغيل)، ولا يُغلق تنبيهاً مملوكاً
// لـOutbox (كان autoCloseResolvedAlerts يقدر يُغلق SAFETY_BREACH/
// COMPLIANCE_VIOLATION/COMPLIANCE_RESTRICTION حتى لو فتحه Outbox للتو).
//
// نموّه شامل لعميل Supabase (module-level createClient في route.ts، لا
// singleton قابل للحقن — بخلاف بقية الـcron routes التي تستورد
// @/app/lib/supabaseAdmin) + محرك الغبار + دوال dustEvaluation المساعدة،
// حتى يمكن قيادة السيناريو كاملاً بلا اعتماد فعلي على قاعدة بيانات حقيقية.
// =====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const insertedAlerts: Record<string, unknown>[] = [];
const insertedAlertEvents: Record<string, unknown>[] = [];
const insertedPm10Readings: Record<string, unknown>[] = [];
// كل الصفوف المفتوحة حالياً في alerts (id → {kind, state}) — يمثّل صفاً
// فتحه Outbox مسبقاً (SAFETY_BREACH)، يُتحقق لاحقاً أنه يبقى NEW/مفتوحاً.
let alertsTable: { id: string; kind: string; state: string; activity_source: string; activity_id: string }[] = [];

const dustProfilesRow = {
  id: 'profile-1',
  project_id: 'project-1',
  activity_group_id: 'group-1',
  activity_type: 'GENERAL_OUTDOOR_WORK',
  regulatory_activity: 'OTHER',
  onsite_pm10: 310, // قيمة ثابتة — راجع تعليق الملف: لا يجوز أن تتحول لسلسلة
  archived_at: null,
  planned_date: new Date().toISOString().slice(0, 10),
  planned_time: new Date().toTimeString().slice(0, 5),
  duration_hours: 4,
  projects: { archived_at: null, latitude: 24.7136, longitude: 46.6753 },
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'project_dust_profiles') {
        const terminal = {
          in: () => terminal,
          then: (resolve: (v: { data: unknown[] }) => void) => resolve({ data: [dustProfilesRow] }),
        };
        return {
          select: () => ({
            is: () => ({
              is: () => terminal,
            }),
          }),
        };
      }
      if (table === 'alerts') {
        return {
          select: () => ({
            eq: (field: string, value: unknown) => {
              const filters: Record<string, unknown> = { [field]: value };
              const builder = {
                eq: (f: string, v: unknown) => { filters[f] = v; return builder; },
                in: (f: string, values: string[]) => { filters[f] = values; return builder; },
                neq: (f: string, v: unknown) => {
                  const rows = alertsTable.filter((a) =>
                    a.activity_source === filters.activity_source &&
                    a.activity_id === filters.activity_id &&
                    (Array.isArray(filters.kind) ? filters.kind.includes(a.kind) : a.kind === filters.kind) &&
                    (a as Record<string, unknown>)[f] !== v
                  );
                  return { then: (resolve: (v: { data: unknown[] }) => void) => resolve({ data: rows }) };
                },
                then: (resolve: (v: { data: unknown[] }) => void) => {
                  const rows = alertsTable.filter((a) =>
                    a.activity_source === filters.activity_source &&
                    a.activity_id === filters.activity_id &&
                    (Array.isArray(filters.kind) ? filters.kind.includes(a.kind) : a.kind === filters.kind)
                  );
                  resolve({ data: rows });
                },
              };
              return builder;
            },
          }),
          insert: (payload: Record<string, unknown>) => {
            insertedAlerts.push(payload);
            const row = { id: `alert-${insertedAlerts.length}`, kind: payload.kind as string, state: 'NEW', activity_source: payload.activity_source as string, activity_id: payload.activity_id as string };
            alertsTable.push(row);
            return { select: () => ({ single: async () => ({ data: { id: row.id }, error: null }) }) };
          },
        };
      }
      if (table === 'alert_state_events') {
        return {
          insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
            const rows = Array.isArray(payload) ? payload : [payload];
            insertedAlertEvents.push(...rows);
            // إغلاق فعلي (محاكاة trigger مزامنة alerts.state) — يسمح
            // للاختبار بالتحقق من حالة Outbox النهائية بعد autoCloseResolvedAlerts.
            for (const ev of rows) {
              const row = alertsTable.find((a) => a.id === ev.alert_id);
              if (row) row.state = ev.new_state as string;
            }
            return { then: (resolve: (v: { data: null }) => void) => resolve({ data: null }) };
          },
        };
      }
      if (table === 'pm10_readings_history') {
        return {
          insert: (payload: Record<string, unknown>) => {
            insertedPm10Readings.push(payload);
            return { then: (resolve: (v: { data: null }) => void) => resolve({ data: null }) };
          },
        };
      }
      throw new Error(`unexpected table in test mock: ${table}`);
    },
  }),
}));

vi.mock('@/app/utils/dust-engine', () => ({
  evaluateDustVisibilityWindow: async () => ({
    worst: {
      score: 40, // دون عتبة RED (65) — لا FORECAST_WARNING/DUST متوقَّعة، يبقي التركيز على PM10/mandatoryStop
      decisionCategory: 'ALLOW',
      mandatoryStop: false,
      decisionLabelAr: 'مسموح',
      time: new Date().toISOString(), // "الآن" — isWorstRightNow=true
      mergedReading: { pm10: 310 },
    },
  }),
}));

vi.mock('@/app/lib/dustEvaluation', () => ({
  resolveFreshProjectDevice: async () => null,
  activityDecisionKey: (projectId: string, activityGroupId: string) => `${projectId}::${activityGroupId}`,
  fetchLatestFinalDecisions: async () =>
    new Map([
      [
        'project-1::group-1',
        { mandatory_stop: false, operational_decision: 'ALLOW', decision_label_ar: 'مسموح' },
      ],
    ]),
  fetchLatestStoredCompliance: async () =>
    new Map([
      [
        'project-1::group-1',
        { decisionCategory: 'ALLOW', shortReasonAr: '', requiredActions: [] },
      ],
    ]),
}));

describe('checkDustActivities — اختبار قبول: لا ينافس Outbox ولا يصنع قراءات PM10 وهمية', () => {
  beforeEach(() => {
    insertedAlerts.length = 0;
    insertedAlertEvents.length = 0;
    insertedPm10Readings.length = 0;
    // صف SAFETY_BREACH مفتوح مسبقاً — يحاكي تنبيهاً فتحه Outbox للتو، خارج
    // أي مسار يعرفه checkDustActivities (لا insertAlert له من هذا المسار).
    alertsTable = [
      { id: 'outbox-alert-1', kind: 'SAFETY_BREACH', state: 'NEW', activity_source: 'dust', activity_id: 'profile-1' },
    ];
  });

  it('تشغيل المولّد 10 مرات لا يزيد عدد قراءات PM10 إطلاقاً (0 قراءات دائماً)', async () => {
    const { checkDustActivities } = await import('./route');
    for (let i = 0; i < 10; i++) {
      await checkDustActivities(['project-1']);
    }
    expect(insertedPm10Readings).toHaveLength(0);
  });

  it('تشغيل المولّد 10 مرات لا يُغلق تنبيه SAFETY_BREACH المملوك لـOutbox', async () => {
    const { checkDustActivities } = await import('./route');
    for (let i = 0; i < 10; i++) {
      await checkDustActivities(['project-1']);
    }
    const outboxAlert = alertsTable.find((a) => a.id === 'outbox-alert-1');
    expect(outboxAlert?.state).toBe('NEW');
    // لا حدث إغلاق كُتب لهذا الصف تحديداً من هذا المسار.
    expect(insertedAlertEvents.some((ev) => ev.alert_id === 'outbox-alert-1' && ev.new_state === 'CLOSED')).toBe(false);
  });

  it('لا ينشئ أبداً تنبيهاً بنوع SAFETY_BREACH/DUST/PM10_APPROACHING_LIMIT/COMPLIANCE_VIOLATION/COMPLIANCE_RESTRICTION (أنواع الحالة الحيّة المحجوزة لـOutbox)', async () => {
    const { checkDustActivities } = await import('./route');
    for (let i = 0; i < 10; i++) {
      await checkDustActivities(['project-1']);
    }
    const forbiddenKinds = ['SAFETY_BREACH', 'DUST', 'PM10_APPROACHING_LIMIT', 'COMPLIANCE_VIOLATION', 'COMPLIANCE_RESTRICTION'];
    const createdKinds = insertedAlerts.map((a) => a.kind);
    expect(createdKinds.some((k) => forbiddenKinds.includes(k as string))).toBe(false);
  });
});
