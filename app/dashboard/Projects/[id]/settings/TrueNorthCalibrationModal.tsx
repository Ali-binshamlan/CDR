'use client';

import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { X, Compass, Loader2 } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "توثيق الشمال الحقيقي: توثيق
// محاذاة اتجاه الرياح موضوع على مستوى المشروع، بينما يجب أن يكون مرتبطاً
// بكل محطة أو حساس اتجاه رياح، ويتضمن: تاريخ التوجيه، طريقة التحقق، الشخص
// المنفذ، الشمال الحقيقي أو المغناطيسي، الانحراف المطبق، مستند أو صورة
// الإثبات"): هذا النموذج يجمع الحقول الستة لجهاز واحد تحديداً — لا حقل
// مشترك واحد لكل أجهزة المشروع كما كان سابقاً (project.true_north_alignment_
// documented). راجع migration 202608060001_device_true_north_calibration.sql
// وapp/api/projects/[projectId]/devices/[deviceId]/route.ts (PATCH) للجانب
// الخادمي.

export interface DeviceTrueNorthState {
  true_north_alignment_documented: boolean | null;
  true_north_alignment_type: 'TRUE_NORTH' | 'MAGNETIC_NORTH' | null;
  true_north_verification_method: string | null;
  true_north_verified_by: string | null;
  true_north_verified_at: string | null;
  true_north_deviation_deg: number | null;
  true_north_evidence_url: string | null;
}

interface TrueNorthCalibrationModalProps {
  projectId: string;
  deviceId: string;
  deviceName: string;
  current: DeviceTrueNorthState;
  onClose: () => void;
  onSaved: () => void;
}

function getApiErrorMessage(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object'
  ) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  if (error instanceof Error) return error.message;
  return undefined;
}

export default function TrueNorthCalibrationModal({
  projectId,
  deviceId,
  deviceName,
  current,
  onClose,
  onSaved,
}: TrueNorthCalibrationModalProps) {
  const [alignmentType, setAlignmentType] = useState<'TRUE_NORTH' | 'MAGNETIC_NORTH' | ''>(current.true_north_alignment_type ?? '');
  const [verificationMethod, setVerificationMethod] = useState(current.true_north_verification_method ?? '');
  const [verifiedBy, setVerifiedBy] = useState(current.true_north_verified_by ?? '');
  const [deviationDeg, setDeviationDeg] = useState(
    current.true_north_deviation_deg !== null ? String(current.true_north_deviation_deg) : ''
  );
  const [evidenceUrl, setEvidenceUrl] = useState(current.true_north_evidence_url ?? '');
  const [saving, setSaving] = useState(false);

  const canDocument = alignmentType !== '' && verificationMethod.trim() !== '' && verifiedBy.trim() !== '';

  const handleSave = async (documented: boolean) => {
    setSaving(true);
    try {
      await apiClient.patch(`/projects/${projectId}/devices/${deviceId}`, {
        trueNorth: {
          documented,
          alignmentType: alignmentType || null,
          verificationMethod: verificationMethod.trim() || null,
          verifiedBy: verifiedBy.trim() || null,
          deviationDeg: deviationDeg.trim() ? Number(deviationDeg) : null,
          evidenceUrl: evidenceUrl.trim() || null,
        },
      });
      toast.success(documented ? 'تم حفظ توثيق المعايرة' : 'تم مسح توثيق المعايرة');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل حفظ توثيق المعايرة');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[#061B40]/10">
          <div className="flex items-center gap-2">
            <Compass className="w-4 h-4 text-[#3995FF]" />
            <h3 className="text-sm font-bold text-[#061B40]">معايرة الشمال الحقيقي — {deviceName}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-[#061B40]/40 hover:text-[#061B40]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-[11px] font-bold text-[#061B40]/50">
            توثيق هذا الجهاز تحديداً يحدد هل يُعتمَد اتجاه الرياح المُرسَل منه في قواعد المستقبِل باتجاه الريح (المسافة عن مناطق سكنية باتجاه هبوب الغبار). بلا توثيق كامل، يُتجاهَل الاتجاه المرسَل من هذا الجهاز في تلك القاعدة تحديداً (بقية القرارات تبقى تعمل بلا تأثير).
          </p>

          <div>
            <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">نوع المحاذاة *</label>
            <select
              value={alignmentType}
              onChange={(e) => setAlignmentType(e.target.value as 'TRUE_NORTH' | 'MAGNETIC_NORTH' | '')}
              className="w-full px-3 py-2 rounded-lg border border-[#061B40]/15 text-sm"
            >
              <option value="">— اختر —</option>
              <option value="TRUE_NORTH">شمال حقيقي (معايَر فلكياً/GPS)</option>
              <option value="MAGNETIC_NORTH">شمال مغناطيسي (يتطلب انحرافاً مُطبَّقاً)</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">طريقة التحقق *</label>
            <input
              type="text"
              value={verificationMethod}
              onChange={(e) => setVerificationMethod(e.target.value)}
              placeholder="مثال: مساحة GPS، بوصلة معايَرة، مقارنة مرجع فلكي"
              className="w-full px-3 py-2 rounded-lg border border-[#061B40]/15 text-sm"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">الشخص/الجهة المنفذة *</label>
            <input
              type="text"
              value={verifiedBy}
              onChange={(e) => setVerifiedBy(e.target.value)}
              placeholder="اسم المساح أو الجهة المسؤولة"
              className="w-full px-3 py-2 rounded-lg border border-[#061B40]/15 text-sm"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">الانحراف المُطبَّق (بالدرجات)</label>
            <input
              type="number"
              step="0.1"
              value={deviationDeg}
              onChange={(e) => setDeviationDeg(e.target.value)}
              placeholder="مثال: 3.5 (اتركه فارغاً إن كان شمالاً حقيقياً بلا انحراف)"
              className="w-full px-3 py-2 rounded-lg border border-[#061B40]/15 text-sm"
              dir="ltr"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">رابط مستند/صورة الإثبات</label>
            <input
              type="url"
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
              placeholder="https://…"
              className="w-full px-3 py-2 rounded-lg border border-[#061B40]/15 text-sm"
              dir="ltr"
            />
          </div>

          {current.true_north_alignment_documented && current.true_north_verified_at && (
            <p className="text-[10px] font-bold text-emerald-600">
              آخر توثيق فعلي: {new Date(current.true_north_verified_at).toLocaleDateString('ar-SA', { calendar: 'gregory' })}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => handleSave(true)}
              disabled={saving || !canDocument}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white text-xs font-bold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              حفظ التوثيق
            </button>
            {current.true_north_alignment_documented && (
              <button
                type="button"
                onClick={() => handleSave(false)}
                disabled={saving}
                className="text-xs font-bold text-red-500 hover:underline px-3"
              >
                مسح التوثيق
              </button>
            )}
          </div>
          {!canDocument && (
            <p className="text-[10px] font-bold text-amber-600">النوع وطريقة التحقق والمنفذ حقول إلزامية لاعتماد التوثيق فعلياً.</p>
          )}
        </div>
      </div>
    </div>
  );
}
