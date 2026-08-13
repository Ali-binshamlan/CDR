import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("تنبيه: متغيرات البيئة لـ Supabase غير معرفة في ملف .env.local");
}

export const supabase = createClient(supabaseUrl, supabaseKey);