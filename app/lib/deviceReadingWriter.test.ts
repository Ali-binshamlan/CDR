import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin.rpc — الكتابة الفعلية بالكامل (device_readings_history/
// pm10_readings_history/project_devices.last_*/device_events/device_
// measurements/device_metric_latest) صارت داخل استدعاء RPC ذرّي واحد
// (ingest_device_reading_and_event_atomic، راجع supabase/migrations/
// 202608040027_merge_device_ingest_atomic.sql).
//
// خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "الكتابتان ليستا عملية واحدة
// ذرية؛ فشل V2 لا يُفشل العملية كلها"): كان هذا الملف يختبر استدعاءين
// منفصلين (ingest_device_reading_atomic ثم ingest_device_event_v2،
// rpcCalls[0]/rpcCalls[1]) — الآن استدعاء واحد فقط، فكل الاختبارات هنا
// تتحقق من rpcCalls[0] حصراً.
let rpcError: { code?: string; message: string } | null = null;
let rpcData: Array<{ is_duplicate: boolean; event_row_id: string }> | null = [
  { is_duplicate: false, event_row_id: 'row-1' },
];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

vi.mock('./supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
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

  it('يستدعي RPC الذري الموحَّد باسم الدالة الصحيح، استدعاءً واحداً فقط، ومقاييس محسوبة فقط للحقول المرسَلة', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 50 },
    });
    expect(result.success).toBe(true);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('ingest_device_reading_and_event_atomic');
    expect(rpcCalls[0].args.p_device_id).toBe('d1');
    expect(rpcCalls[0].args.p_project_id).toBe('p1');
    expect(rpcCalls[0].args.p_measurements).toEqual({ pm10: 50 });
  });

  it('يُضمِّن p_measurements_v2 بصيغة {value, observedAtIso} لكل حقل يملك fields مستقلة', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: {
        pm10: 50,
        observedAtIso: '2026-01-01T00:00:00.000Z',
        fields: {
          pm10: { value: 50, observedAtIso: '2026-01-01T00:00:00.000Z' },
        },
      },
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_measurements_v2).toEqual({
      pm10: { value: 50, observedAtIso: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('حقل بلا fields مستقلة → غائب من p_measurements_v2 (الـRPC يبني fallback بـp_observed_at المشتركة)', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: {
        pm10: 50,
        temperatureC: 35,
        observedAtIso: '2026-01-01T00:00:00.000Z',
        fields: {
          pm10: { value: 50, observedAtIso: '2026-01-01T00:05:00.000Z' },
          // temperatureC غائب من fields عمداً
        },
      },
    });
    const measurementsV2 = rpcCalls[0].args.p_measurements_v2 as Record<string, { value: number; observedAtIso: string }>;
    expect(measurementsV2.pm10).toEqual({ value: 50, observedAtIso: '2026-01-01T00:05:00.000Z' });
    expect(measurementsV2.temperatureC).toBeUndefined();
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "ThingsBoard ما زال يعيد تأريخ
  // PM10 القديم كقراءة حديثة"): p_observed_at الممرَّر هو الوقت المشترك
  // (أحدث حقل بين كل القياسات)، لا وقت PM10 تحديداً — فحرارة حديثة الساعة
  // 10:00 مع PM10 لم يتغيّر منذ 08:00 كانت تجعل pm10_readings_history.
  // recorded_at يُسجَّل 10:00 خطأً. p_pm10_observed_at يحمل وقت PM10 الفردي
  // الصحيح من reading.fields.pm10.observedAtIso.
  it('p_pm10_observed_at يُمرَّر من reading.fields.pm10.observedAtIso — مستقل عن observedAtIso المشترك الأحدث', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: {
        pm10: 500,
        temperatureC: 35,
        observedAtIso: '2026-01-01T10:00:00.000Z', // أحدث حقل (الحرارة)
        fields: {
          pm10: { value: 500, observedAtIso: '2026-01-01T08:00:00.000Z' }, // PM10 أقدم فعلياً
          temperatureC: { value: 35, observedAtIso: '2026-01-01T10:00:00.000Z' },
        },
      },
    });
    expect(rpcCalls[0].fn).toBe('ingest_device_reading_and_event_atomic');
    expect(rpcCalls[0].args.p_observed_at).toBe('2026-01-01T10:00:00.000Z');
    expect(rpcCalls[0].args.p_pm10_observed_at).toBe('2026-01-01T08:00:00.000Z');
  });

  it('p_pm10_observed_at غائب (null) حين لا يوفّر reading.fields.pm10 — توافق مصادر push قديمة', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 50, observedAtIso: '2026-01-01T00:00:00.000Z' },
    });
    expect(rpcCalls[0].args.p_pm10_observed_at).toBeNull();
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

  // القسم 5.10 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "Provider Pull
  // والكاتب الداخلي وSQL ما زالت تقبل null ولا تتحقق من sequence": Provider
  // Pull (موصلات مثل ThingsBoard) لا تملك مفهوم sequence أصلاً، فلا تُمرِّره
  // إطلاقاً — يجب أن يُشتَق رقم بديل حتمي غير سالب من observedAtIso بدل ترك
  // p_sequence_no يمر null إلى الـRPC (الذي يرفضه صراحة).
  it('sequence غائب تماماً + observedAtIso موجود → يُشتَق من observedAtIso (طابع Unix بالمللي ثانية)، لا null', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const observedAtIso = '2026-01-01T00:00:00.000Z';
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30, observedAtIso },
    });
    const expectedSequence = new Date(observedAtIso).getTime();
    expect(rpcCalls[0].args.p_sequence_no).toBe(expectedSequence);
    expect(rpcCalls[0].args.p_sequence_no).not.toBeNull();
  });

  it('sequence غائب وobservedAtIso غائب أيضاً → يُشتَق من وقت الآن (receivedAt)، لا null', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30 },
    });
    expect(rpcCalls[0].args.p_sequence_no).not.toBeNull();
    expect(typeof rpcCalls[0].args.p_sequence_no).toBe('number');
    expect(rpcCalls[0].args.p_sequence_no).toBeGreaterThan(0);
  });

  it('sequence=0 صراحةً → يمر كما هو (0 قيمة صالحة، لا يُستبدَل بالمشتق لمجرد أنه falsy)', async () => {
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30 },
      sequence: 0,
    });
    expect(rpcCalls[0].args.p_sequence_no).toBe(0);
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

  // خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "الكتابتان ليستا عملية واحدة
  // ذرية"): بما أن كل الكتابات الآن داخل استدعاء واحد ذرّي، فشل أي جزء منه
  // (بما فيه ما كان سابقاً "الكتابة الثانية" V2) يُفشل العملية كاملة فوراً —
  // لا console.error صامتاً، لا نجاح جزئي.
  it('يرجع فشلاً برسالة الخطأ حين تفشل RPC الموحَّدة — لا نجاح جزئي، ولا استدعاء إضافي', async () => {
    rpcError = { code: '42501', message: 'device not found, revoked, or project mismatch' };
    const { writeDeviceReading } = await import('./deviceReadingWriter');
    const result = await writeDeviceReading({
      deviceId: 'd1',
      projectId: 'p1',
      reading: { pm10: 30 },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('device not found');
    expect(rpcCalls).toHaveLength(1);
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
