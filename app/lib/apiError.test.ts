import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeErrorResponse } from './apiError';

// خطأ تشخيصي حرج مكتشَف ومُصلَح (المستخدم لاحظ إصلاحاً لا يظهر أثره —
// Vercel logs أظهرت "[object Object]" بلا أي تفاصيل فعلية عن سبب فشل
// insert_dust_profile_atomic الحقيقي): error instanceof Error كان false
// دائماً لأخطاء Supabase/PostgREST (كائن عادي {message, details, hint,
// code}، ليس JS Error)، فيسقط إلى String(error) التي تطبع "[object Object]"
// حرفياً — يُفقِد رسالة الخطأ الحقيقية في السجل عبر كل الـ81 موقع استدعاء
// لهذه الدالة في المشروع.
describe('safeErrorResponse — استخراج رسالة الخطأ الحقيقية للسجل', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('كائن خطأ Supabase/PostgREST العادي ({message, code, ...}, ليس instanceof Error) — يُستخرَج message الحقيقي في console.error، لا "[object Object]"', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabaseError = {
      message: 'null value in column "activity_type" violates not-null constraint',
      code: '23502',
      details: null,
      hint: null,
    };
    safeErrorResponse(supabaseError, 'test-context');

    expect(consoleSpy).toHaveBeenCalledWith(
      'test-context:',
      'null value in column "activity_type" violates not-null constraint'
    );
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.anything(), '[object Object]');
  });

  it('JS Error حقيقي — يبقى بنفس السلوك السابق (error.message)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeErrorResponse(new Error('boom'), 'ctx');
    expect(consoleSpy).toHaveBeenCalledWith('ctx:', 'boom');
  });

  it('كائن بلا حقل message إطلاقاً — يسقط إلى String(error) كحل أخير (لا انهيار)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeErrorResponse({ foo: 'bar' }, 'ctx');
    expect(consoleSpy).toHaveBeenCalledWith('ctx:', '[object Object]');
  });

  it('قيمة نصية بدائية — تُطبَع كما هي', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeErrorResponse('raw string error', 'ctx');
    expect(consoleSpy).toHaveBeenCalledWith('ctx:', 'raw string error');
  });

  it('message ليس نصاً (رقم مثلاً) — لا يُستخدم، يسقط إلى String(error)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeErrorResponse({ message: 12345 }, 'ctx');
    expect(consoleSpy).toHaveBeenCalledWith('ctx:', '[object Object]');
  });

  it('الرسالة المُرجَعة للعميل تبقى عامة دائماً — لا تسريب لأي تفاصيل داخلية', () => {
    const result = safeErrorResponse({ message: 'duplicate key value violates unique constraint "idx_x"' });
    expect(result).not.toContain('idx_x');
    expect(result).toContain('حدث خطأ');
  });
});
