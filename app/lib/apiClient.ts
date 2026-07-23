import axios from 'axios';
import { supabase } from './supabase';

// عميل axios موحّد لكل نداءات /api/** من المتصفح — يرفق تلقائياً رأس
// Authorization: Bearer <access_token> لجلسة المستخدم الحالية قبل كل
// طلب، حتى تستطيع الـ API routes الخادمية (supabaseAdmin) التحقق من
// الهوية عبر requireUserId (راجع app/lib/apiAuth.ts). بدون هذا، كل ملف
// يستدعي axios كان سيحتاج تكرار قراءة الجلسة وإرفاق الرأس يدوياً.
export const apiClient = axios.create({ baseURL: '/api' });

apiClient.interceptors.request.use(async (config) => {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
