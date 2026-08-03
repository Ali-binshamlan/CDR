import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin.rpc — الكتابة الفعلية بالكامل (تحديث project_devices +
// إدراج device_readings_history + إدراج pm10_readings_history) صارت داخل
// RPC ذرّي واحد (ingest_device_reading_atomic، راجع supabase/migrations/
// 202608020004_atomic_device_ingest.sql) بعد إصلاح "إدخال الجهاز ليس
// معاملة SQL واحدة" — الاختبارات هنا تتحقق من الـpayload الممرَّر للـRPC
// (التحقق من القيم + observedAt/receivedAt) لا من تفاصيل جداول داخلية لم
// تعد جزءاً من هذا الملف.
let rpcError: { code?: string; message: string } | null = null;
let rpcData: Array<{ is_duplicate: boolean; event_row_id: string }> | null = [
  { is_duplicate: false, event_row_id: 'row-1' },
];
const rpcCalls: Array<{ fn: string; args: any }> = [];

vi.mock('./supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return { data: rpcError ? null : rpcData, error: rpcError };
    },
  },
}));

describe('writeDeviceReading', () => {
  beforeEach(() => {
    rpcError = null;
    rpcData = [{ is_duplicate: false, event_row_id: 'row-1' }];
    rpcCalls.length = 0;
  });

  it('يرفض قراءة بلا أي حقل قياس', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({ deviceId: 'd1', projectId: 'p1', reading: {} });
    expect(result.success).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض windDirectionDeg خارج نطاق 0-360', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { windDirectionDeg: 400 },
    });
    expect(result.success).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض relativeHumidityPercent خارج نطاق 0-100', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { relativeHumidityPercent: 150 },
    });
    expect(result.success).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يستدعي RPC الذري باسم الدالة الصحيح ومقاييس محسوبة فقط للحقول المرسَلة', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 50 },
    });
    expect(result.success).toBe(true);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('ingest_device_reading_atomic');
    expect(rpcCalls[0].args.p_device_id).toBe('d1');
    expect(rpcCalls[0].args.p_project_id).toBe('p1');
    expect(rpcCalls[0].args.p_measurements).toEqual({ pm10: 50 });
  });

  it('يمرر externalEventId وsequence كما هي إلى RPC', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30 },
      externalEventId: 'evt-1',
      sequence: 42,
    });
    expect(rpcCalls[0].args.p_external_event_id).toBe('evt-1');
    expect(rpcCalls[0].args.p_sequence_no).toBe(42);
  });

  it('يرجع duplicate:true حين تُرجع RPC is_duplicate=true (تعارض idempotency داخل قاعدة البيانات)', async () => {
    rpcData = [{ is_duplicate: true, event_row_id: 'existing-1' }];
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30 },
      externalEventId: 'evt-1',
    });
    expect(result).toEqual({ success: true, duplicate: true });
  });

  it('يرجع فشلاً برسالة الخطأ حين تفشل RPC', async () => {
    rpcError = { code: '42501', message: 'device not found, revoked, or project mismatch' };
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30 },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('device not found');
  });

  it('يستخدم observedAtIso كـp_observed_at عند وجوده، لا وقت الآن', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const observedAtIso = '2026-01-01T00:00:00.000Z';
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30, observedAtIso },
    });
    expect(rpcCalls[0].args.p_observed_at).toBe(observedAtIso);
    // p_received_at يبقى وقت الآن دائماً (منفصل عن p_observed_at) — لا يساوي
    // observedAtIso الثابت المُمرَّر هنا.
    expect(rpcCalls[0].args.p_received_at).not.toBe(observedAtIso);
  });

  it('يستخدم وقت الآن كـp_observed_at حين observedAtIso غائب (توافق أجهزة قديمة)', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30 },
    });
    expect(rpcCalls[0].args.p_observed_at).toBe(rpcCalls[0].args.p_received_at);
  });
});
