'use client';

import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { X, Wifi, CheckCircle2, Loader2 } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';
import type {
  ProviderCredentialField,
  VendorStation,
  ConnectionTestResult,
  ProviderCredentials,
} from '@/app/lib/providers/types';

// شكل عنصر واحد من GET /api/providers (listAvailableProviders في
// app/lib/providers/registry.ts) — id/displayName/credentialFields فقط،
// بلا testConnection/listStations/fetchLatestReading (تلك دوال سيرفر فقط،
// لا تُصدَّر عبر JSON).
interface ProviderInfo {
  id: string;
  displayName: string;
  credentialFields?: ProviderCredentialField[];
  requiresProviderInstance?: boolean;
}

// عنصر واحد من GET /api/providers/instances — منصات معتمدة ونشطة فقط
// (القسم 15.1)، يختار المستخدم منها بدل كتابة base_url حر.
interface ProviderInstanceInfo {
  id: string;
  provider: string;
  origin: string;
  hostname: string;
}

// يستخرج رسالة خطأ آمنة للعرض من استجابة apiClient (axios) الفاشلة، أو من
// أي خطأ JS عادي — بلا افتراض شكل any. نفس منطق app/login/page.tsx.
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

// نموذج حقول الاتصال الافتراضي — يُستخدم لأي Connector لا يُعرِّف
// credentialFields الخاصة به (نقطة توسّع اختيارية، راجع app/lib/providers/types.ts).
// لا يتضمن base_url (القسم 15.1 — Connectors التي تتصل بشبكة خارجية فعلياً
// تُلزَم بـrequiresProviderInstance وتحصل على origin من provider_instances،
// لا من هذا النموذج).
const DEFAULT_CREDENTIAL_FIELDS: ProviderCredentialField[] = [
  { key: 'api_key', label: 'مفتاح API', type: 'password', required: true },
];

type Step = 'select-provider' | 'select-instance' | 'credentials' | 'select-station';

interface ConnectProviderModalProps {
  projectId: string;
  deviceId: string;
  deviceName: string;
  onClose: () => void;
  onConnected: () => void;
}

export default function ConnectProviderModal({ projectId, deviceId, deviceName, onClose, onConnected }: ConnectProviderModalProps) {
  const [step, setStep] = useState<Step>('select-provider');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState('');

  const [instances, setInstances] = useState<ProviderInstanceInfo[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState('');

  const [credentials, setCredentials] = useState<ProviderCredentials>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const [loadingStations, setLoadingStations] = useState(false);
  const [stations, setStations] = useState<VendorStation[]>([]);
  const [selectedStationId, setSelectedStationId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiClient.get('/providers');
        setProviders(data?.providers || []);
      } catch {
        toast.error('فشل جلب قائمة مصادر البيانات');
      } finally {
        setLoadingProviders(false);
      }
    })();
  }, []);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) || null;
  const credentialFields = selectedProvider?.credentialFields?.length ? selectedProvider.credentialFields : DEFAULT_CREDENTIAL_FIELDS;

  const handleSelectProvider = async (providerId: string) => {
    setSelectedProviderId(providerId);
    setCredentials({});
    setTestResult(null);
    setSelectedInstanceId('');

    const provider = providers.find((p) => p.id === providerId);
    if (provider?.requiresProviderInstance) {
      setLoadingInstances(true);
      setStep('select-instance');
      try {
        const { data } = await apiClient.get('/providers/instances', { params: { provider: providerId } });
        setInstances(data?.instances || []);
      } catch {
        toast.error('فشل جلب قائمة المنصات المعتمدة');
      } finally {
        setLoadingInstances(false);
      }
      return;
    }
    setStep('credentials');
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await apiClient.post('/providers/test-connection', {
        provider: selectedProviderId,
        providerInstanceId: selectedInstanceId || undefined,
        credentials,
      });
      setTestResult(data);
    } catch (error) {
      setTestResult({ success: false, errorMessage: getApiErrorMessage(error) || 'تعذّر اختبار الاتصال' });
    } finally {
      setTesting(false);
    }
  };

  const handleFetchStations = async () => {
    setLoadingStations(true);
    try {
      const { data } = await apiClient.post('/providers/list-stations', {
        provider: selectedProviderId,
        providerInstanceId: selectedInstanceId || undefined,
        credentials,
      });
      setStations(data?.stations || []);
      setStep('select-station');
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل جلب قائمة المحطات');
    } finally {
      setLoadingStations(false);
    }
  };

  const handleSaveConnection = async () => {
    const station = stations.find((s) => s.vendorStationId === selectedStationId);
    if (!station) {
      toast.error('اختر محطة أولاً');
      return;
    }
    setSaving(true);
    try {
      await apiClient.post(`/projects/${projectId}/devices/${deviceId}/provider-connection`, {
        provider: selectedProviderId,
        providerInstanceId: selectedInstanceId || undefined,
        credentials,
        vendorStationId: station.vendorStationId,
        vendorStationName: station.vendorStationName,
      });
      toast.success('تم ربط مصدر البيانات بنجاح');
      onConnected();
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل حفظ الربط');
    } finally {
      setSaving(false);
    }
  };

  const requiredFieldsFilled = credentialFields.filter((f) => f.required).every((f) => credentials[f.key]?.trim());

  return (
    <div className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[#061B40]/10">
          <div className="flex items-center gap-2">
            <Wifi className="w-4 h-4 text-[#3995FF]" />
            <h3 className="text-sm font-bold text-[#061B40]">ربط مصدر بيانات — {deviceName}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-[#061B40]/40 hover:text-[#061B40]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {step === 'select-provider' && (
            <div>
              <p className="text-[11px] font-bold text-[#061B40]/50 mb-3">اختر الشركة/المزوّد الذي تنتمي إليه محطتك.</p>
              {loadingProviders ? (
                <p className="text-[12px] font-bold text-[#061B40]/40">جاري التحميل...</p>
              ) : providers.length === 0 ? (
                <p className="text-[11px] font-bold text-[#061B40]/40">لا يوجد أي مصدر بيانات مسجَّل بالنظام حالياً.</p>
              ) : (
                <div className="space-y-2">
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleSelectProvider(p.id)}
                      className="w-full text-right p-3 rounded-lg border border-[#061B40]/10 bg-[#F4F7FB] hover:bg-[#3995FF]/10 hover:border-[#3995FF]/30 transition-all text-sm font-bold text-[#061B40]"
                    >
                      {p.displayName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 'select-instance' && (
            <div className="space-y-3">
              <button type="button" onClick={() => setStep('select-provider')} className="text-[11px] font-bold text-[#3995FF] hover:underline">
                ← رجوع لاختيار المزوّد
              </button>
              <p className="text-[11px] font-bold text-[#061B40]/50 mb-1">
                اختر المنصة المعتمدة من قبل مسؤول النظام — لا يمكن إدخال رابط منصة مخصَّص.
              </p>
              {loadingInstances ? (
                <p className="text-[12px] font-bold text-[#061B40]/40">جاري التحميل...</p>
              ) : instances.length === 0 ? (
                <p className="text-[11px] font-bold text-[#061B40]/40">
                  لا توجد منصات معتمدة لهذا المزوّد حالياً. تواصل مع مسؤول النظام لاعتماد منصتك.
                </p>
              ) : (
                <div className="space-y-2">
                  {instances.map((inst) => (
                    <label
                      key={inst.id}
                      className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-all ${
                        selectedInstanceId === inst.id ? 'bg-[#3995FF]/10 border-[#3995FF]' : 'bg-[#F4F7FB] border-[#061B40]/10'
                      }`}
                    >
                      <input
                        type="radio"
                        name="instance"
                        checked={selectedInstanceId === inst.id}
                        onChange={() => setSelectedInstanceId(inst.id)}
                        className="accent-[#3995FF]"
                      />
                      <span className="text-sm font-bold text-[#061B40]" dir="ltr">{inst.origin}</span>
                    </label>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setCredentials({});
                  setTestResult(null);
                  setStep('credentials');
                }}
                disabled={!selectedInstanceId}
                className="w-full bg-[#061B40] hover:bg-[#061B40]/90 disabled:bg-gray-300 text-white text-xs font-bold py-2.5 rounded-lg transition-all"
              >
                متابعة
              </button>
            </div>
          )}

          {step === 'credentials' && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setStep(selectedProvider?.requiresProviderInstance ? 'select-instance' : 'select-provider')}
                className="text-[11px] font-bold text-[#3995FF] hover:underline"
              >
                ← رجوع
              </button>
              {credentialFields.map((field) => (
                <div key={field.key}>
                  <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">
                    {field.label}{field.required && ' *'}
                  </label>
                  <input
                    type={field.type}
                    value={credentials[field.key] || ''}
                    onChange={(e) => {
                      setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }));
                      setTestResult(null);
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-[#061B40]/15 text-sm"
                    dir="ltr"
                  />
                </div>
              ))}

              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testing || !requiredFieldsFilled}
                className="w-full bg-[#061B40] hover:bg-[#061B40]/90 disabled:bg-gray-300 text-white text-xs font-bold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                {testing && <Loader2 className="w-4 h-4 animate-spin" />}
                اختبار الاتصال
              </button>

              {testResult && (
                <div className={`text-[11px] font-bold p-2.5 rounded-lg ${testResult.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                  {testResult.success ? '✓ الاتصال ناجح' : `✗ ${testResult.errorMessage || 'فشل الاتصال'}`}
                </div>
              )}

              {testResult?.success && (
                <button
                  type="button"
                  onClick={handleFetchStations}
                  disabled={loadingStations}
                  className="w-full bg-[#3995FF] hover:bg-[#3995FF]/90 disabled:bg-gray-300 text-white text-xs font-bold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
                >
                  {loadingStations && <Loader2 className="w-4 h-4 animate-spin" />}
                  جلب المحطات
                </button>
              )}
            </div>
          )}

          {step === 'select-station' && (
            <div className="space-y-3">
              <button type="button" onClick={() => setStep('credentials')} className="text-[11px] font-bold text-[#3995FF] hover:underline">
                ← رجوع لبيانات الاتصال
              </button>
              <p className="text-[11px] font-bold text-[#061B40]/50">اختر المحطة التي تقابل هذا الجهاز داخل النظام.</p>
              {stations.length === 0 ? (
                <p className="text-[11px] font-bold text-[#061B40]/40">لا توجد محطات متاحة بهذا الحساب.</p>
              ) : (
                <div className="space-y-2">
                  {stations.map((s) => (
                    <label
                      key={s.vendorStationId}
                      className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-all ${
                        selectedStationId === s.vendorStationId ? 'bg-[#3995FF]/10 border-[#3995FF]' : 'bg-[#F4F7FB] border-[#061B40]/10'
                      }`}
                    >
                      <input
                        type="radio"
                        name="station"
                        checked={selectedStationId === s.vendorStationId}
                        onChange={() => setSelectedStationId(s.vendorStationId)}
                        className="accent-[#3995FF]"
                      />
                      <span className="text-sm font-bold text-[#061B40]">{s.vendorStationName}</span>
                    </label>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={handleSaveConnection}
                disabled={saving || !selectedStationId}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white text-xs font-bold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                حفظ الربط
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
