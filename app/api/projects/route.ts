import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';

// يستبدل supabase.from('projects').insert(...) المباشر من
// Projects/create/page.tsx — user_id يُشتق من التوكن (auth.userId) وليس
// من body المرسَل، حتى لا يستطيع أحد إنشاء مشروع باسم مستخدم آخر
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json();
  const project = body?.project;
  if (!project || typeof project !== 'object') {
    return NextResponse.json({ error: 'project مطلوب' }, { status: 400 });
  }

  // ورديات العمل (project_shifts) جدول منفصل — لا يجوز تمريرها كعمود ضمن
  // insert على جدول projects نفسه (راجع supabase-project-shifts-migration.sql).
  const shifts = Array.isArray(project.shifts) ? project.shifts : [];
  const projectInsert = { ...project };
  delete projectInsert.shifts;

  const { data: insertedProject, error: projectError } = await supabaseAdmin
    .from('projects')
    .insert([{ ...projectInsert, user_id: auth.userId }])
    .select()
    .single();

  if (projectError) {
    console.error('🚨 خطأ Supabase عند إدراج المشروع:', projectError);
    let message = `فشل حفظ المشروع: ${projectError.message}`;
    if (projectError.code === '42501' || /row-level security/i.test(projectError.message)) {
      message = 'تم رفض الحفظ بواسطة سياسات الأمان (RLS) على جدول المشاريع. تأكد من صلاحيات المستخدم.';
    } else if (projectError.code === '23502') {
      message = `حقل إلزامي مفقود في جدول المشاريع: ${projectError.message}`;
    } else if (projectError.code === '23505') {
      message = 'يوجد مشروع آخر بنفس البيانات الفريدة (تكرار).';
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!insertedProject?.id) {
    return NextResponse.json(
      { error: 'تم إرسال طلب حفظ المشروع لكن لم يتم استلام بيانات المشروع المُنشأ من قاعدة البيانات.' },
      { status: 500 }
    );
  }

  // إدراج الورديات (إن وُجدت) بعد نجاح إدراج المشروع — فشل هذه الخطوة لا
  // يجوز أن يُسقط المشروع بأكمله (أُنشئ بالفعل)، فقط يُبلَّغ كخطأ منفصل.
  if (shifts.length > 0) {
    const shiftRows = shifts.map((s: any, i: number) => ({
      project_id: insertedProject.id,
      name: s.name,
      start_time: s.start_time,
      end_time: s.end_time,
      sort_order: i,
    }));
    const { error: shiftsError } = await supabaseAdmin.from('project_shifts').insert(shiftRows);
    if (shiftsError) {
      console.error('🚨 فشل حفظ ورديات العمل:', shiftsError);
      return NextResponse.json({
        data: insertedProject,
        warning: `تم إنشاء المشروع لكن فشل حفظ ورديات العمل: ${shiftsError.message}`,
      });
    }
  }

  return NextResponse.json({ data: insertedProject });
}
