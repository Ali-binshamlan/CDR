import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { persistActivityDecisionsAtomic, NEUTRAL_DVI_FALLBACK } from './dustEvaluation';
import type { DustResultItem, DustComplianceResultItem } from './dustEvaluation';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';

// خطأ إعادة إنتاج مكتشَف ومُصلَح (مراجعة كود خبير — "روابط DVI والامتثال
// قد تشير إلى تقييم سابق عندما لا تتغير فئة القرار خلال خمس دقائق، رغم
// تغير القراءة والتفاصيل الفعلية"، migration 202608160002): persistActivityDecisionsAtomic
// كانت تُمرِّر p_dvi_result/p_compliance_result فقط (null حين shouldSkipPersist
// تتخطّى تحديث current_dust_decisions/current_dust_compliance_decisions) —
// فيسقط RPC لقراءة latest_evaluation_id قديم قد لا يطابق القراءة الطازجة
// فعلياً المُستخدَمة لبناء finalDecisionPayload. الإصلاح: p_dvi_raw_result/
// p_compliance_raw_result يُمرَّران دائماً (نفس worst/complianceEntry.result
// الطازجين)، بصرف النظر عن shouldSkipPersist — هذا الملف يثبت أن الجانب TS
// يبني استدعاء RPC بهذا الشكل الصحيح (اختبار تكامل RPC الفعلي في
// supabase/tests/concurrency.dbtest.ts).

function minimalAei(): AeiEvaluationResult {
  return {
    indicatorType: 'AEI',
    activityLabelAr: 'test',
    status: 'ALLOW',
    statusLabelAr: 'قابل للتنفيذ',
    color: 'GREEN',
    score: 100,
    safetyScore: 100,
    qualityScore: 100,
    baseScore: 100,
    closedByGate: false,
    cappedByGate: false,
    gateReasonAr: null,
    isHoldForVerification: false,
    shortReasonAr: '',
    recommendationAr: '',
    sources: [],
  };
}

function minimalDustResult(overrides: Partial<DustResultItem> = {}): DustResultItem {
  return {
    activityGroupId: 'group-1',
    activityId: 'activity-1',
    activityType: 'EARTHWORKS',
    windowEval: {
      worst: { ...NEUTRAL_DVI_FALLBACK, decisionCategory: 'ALLOW', shortReason: 'fresh-reading', score: 7 },
    } as unknown as DustResultItem['windowEval'],
    aei: minimalAei(),
    hourlyForecasts: [],
    startIso: new Date().toISOString(),
    ...overrides,
  } as DustResultItem;
}

function minimalComplianceResult(overrides: Partial<DustComplianceResultItem> = {}): DustComplianceResultItem {
  return {
    activityGroupId: 'group-1',
    activityId: 'activity-1',
    dustProfileId: 'activity-1',
    result: {
      decisionCategory: 'ALLOW',
      triggeredRules: [],
      shortReasonAr: 'fresh-reading',
      rulebookVersion: 'test',
    } as unknown as DustComplianceResultItem['result'],
    ...overrides,
  };
}

describe('persistActivityDecisionsAtomic — p_dvi_raw_result/p_compliance_raw_result يُمرَّران دائماً بصرف النظر عن shouldSkipPersist', () => {
  it('shouldSkipPersist تتخطّى current_dust_decisions (نفس الفئة، أقل من 5 دقائق) → p_dvi_result=null لكن p_dvi_raw_result يحمل القراءة الطازجة', async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const mockSupabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (table === 'current_dust_decisions') {
                  // فئة مطابقة (ALLOW) وupdated_at قبل دقيقة واحدة فقط —
                  // shouldSkipPersist سترجع true، دفع p_dvi_result إلى null.
                  return { data: { decision: 'ALLOW', updated_at: new Date(Date.now() - 60_000).toISOString() }, error: null };
                }
                if (table === 'current_dust_compliance_decisions') {
                  return {
                    data: {
                      decision: 'ALLOW',
                      updated_at: new Date(Date.now() - 60_000).toISOString(),
                      stopped_since: null,
                      pending_resume_since: null,
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
            }),
          }),
        }),
      }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'persist_activity_decision_atomic') {
          capturedArgs = args;
          return { data: [{ dvi_persisted: false, compliance_persisted: false, final_decision_persisted: true }], error: null };
        }
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient;

    const dustResults = [minimalDustResult()];
    const complianceResults = [minimalComplianceResult()];

    await persistActivityDecisionsAtomic(mockSupabase, 'project-1', dustResults, complianceResults, 'user_refresh', 'user_refresh');

    expect(capturedArgs).not.toBeNull();
    // الفئة لم تتغيّر خلال أقل من 5 دقائق → shouldSkipPersist=true → CAS مُتخطّى.
    expect(capturedArgs!.p_dvi_result).toBeNull();
    expect(capturedArgs!.p_compliance_result).toBeNull();
    // لكن القراءة الطازجة يجب أن تصل دائماً — هذا هو الإصلاح.
    expect(capturedArgs!.p_dvi_raw_result).not.toBeNull();
    expect((capturedArgs!.p_dvi_raw_result as Record<string, unknown>).shortReason).toBe('fresh-reading');
    expect(capturedArgs!.p_compliance_raw_result).not.toBeNull();
    expect((capturedArgs!.p_compliance_raw_result as Record<string, unknown>).shortReasonAr).toBe('fresh-reading');
  });

  it('لا نتيجة DVI/امتثال إطلاقاً لهذا النشاط → p_dvi_raw_result/p_compliance_raw_result يبقيان null (لا قراءة وهمية)', async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const mockSupabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
      }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'persist_activity_decision_atomic') {
          capturedArgs = args;
          return { data: [{ dvi_persisted: true, compliance_persisted: false, final_decision_persisted: true }], error: null };
        }
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient;

    // بلا windowEval.worst إطلاقاً (نشاط بلا نتيجة DVI بعد) — لكن aei موجود
    // فيصل finalDecisionPayload عبر NEUTRAL_DVI_FALLBACK (منطق موجود مسبقاً).
    const dustResults = [minimalDustResult({ windowEval: {} as unknown as DustResultItem['windowEval'] })];

    await persistActivityDecisionsAtomic(mockSupabase, 'project-1', dustResults, [], 'user_refresh', 'user_refresh');

    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.p_dvi_raw_result).toBeNull();
    expect(capturedArgs!.p_compliance_raw_result).toBeNull();
  });
});
