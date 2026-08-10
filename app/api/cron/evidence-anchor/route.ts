import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';

// بنية Tamper-Evidence — المرحلة 3: يقرأ آخر صف من evidence_hash_ledger
// (202608110007/202608110008) ويثبّته على GitHub — مستودع مستقل تماماً عن
// مالك قاعدة Supabase (لا HMAC، لا مشروع Supabase ثانٍ تحت نفس نموذج
// التهديد). حتى لو أُعيد كتابة الدفتر بأثر رجعي بالكامل من دور مالك
// القاعدة، القيم المُثبَّتة هنا قبل التلاعب تبقى دليلاً مستقلاً.
//
// api.github.com مضيف ثابت موثوق (لا رابط مُهيَّأ من مستخدم/مسؤول) — يُستخدَم
// fetch مباشرة بـAbortSignal.timeout، لا safeFetch (المصمَّمة خصيصاً لحماية
// SSRF على روابط provider_connections القابلة للتهيئة من المستخدم).
//
// يُسجَّل كل تشغيلة في evidence_anchor_runs حتى عند فشل GitHub — يميّز
// "لم تعمل الدورة" (غياب أي صف) عن "عملت وفشل الاتصال" (صف بـerror).
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_BRANCH = 'evidence-anchor-log';

function githubRepoFromEnv(): { owner: string; repo: string } | null {
  const raw = process.env.GITHUB_EVIDENCE_ANCHOR_REPO; // صيغة "owner/repo"
  if (!raw || !raw.includes('/')) return null;
  const [owner, repo] = raw.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export async function GET(request: Request) {
  if (!process.env.EVIDENCE_ANCHOR_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'EVIDENCE_ANCHOR_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.EVIDENCE_ANCHOR_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const githubToken = process.env.GITHUB_EVIDENCE_ANCHOR_TOKEN;
  const repoConfig = githubRepoFromEnv();
  if (!githubToken || !repoConfig) {
    return NextResponse.json(
      { ok: false, error: 'GITHUB_EVIDENCE_ANCHOR_TOKEN أو GITHUB_EVIDENCE_ANCHOR_REPO غير مُعرَّفين بالخادم' },
      { status: 503 }
    );
  }

  const { data: latestRow, error: latestError } = await supabaseAdmin
    .from('evidence_hash_ledger')
    .select('seq, chain_hash, source_table, source_row_id, row_created_at')
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) {
    return NextResponse.json({ ok: false, error: latestError.message }, { status: 500 });
  }
  if (!latestRow) {
    return NextResponse.json({ ok: false, error: 'evidence_hash_ledger فارغ — لا شيء لتثبيته' }, { status: 500 });
  }

  const anchorPath = `evidence-anchors/${latestRow.seq}.json`;
  const anchorContent = JSON.stringify(
    {
      seq: latestRow.seq,
      chain_hash: latestRow.chain_hash,
      source_table: latestRow.source_table,
      source_row_id: latestRow.source_row_id,
      row_created_at: latestRow.row_created_at,
      anchored_at: new Date().toISOString(),
    },
    null,
    2
  );

  let githubCommitSha: string | null = null;
  let anchorError: string | null = null;

  try {
    const putResponse = await fetch(
      `${GITHUB_API_BASE}/repos/${repoConfig.owner}/${repoConfig.repo}/contents/${anchorPath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          message: `evidence anchor seq=${latestRow.seq}`,
          content: Buffer.from(anchorContent, 'utf-8').toString('base64'),
          branch: GITHUB_BRANCH,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    if (!putResponse.ok) {
      const body = await putResponse.text().catch(() => '');
      anchorError = `GitHub ${putResponse.status}: ${body.slice(0, 500)}`;
    } else {
      const putBody = (await putResponse.json()) as { commit?: { sha?: string } };
      githubCommitSha = putBody.commit?.sha ?? null;
    }
  } catch (err) {
    anchorError = err instanceof Error ? err.message : 'خطأ غير معروف أثناء الاتصال بـGitHub';
  }

  const { error: insertError } = await supabaseAdmin.from('evidence_anchor_runs').insert({
    ledger_seq: latestRow.seq,
    chain_hash: latestRow.chain_hash,
    github_commit_sha: githubCommitSha,
    github_path: anchorPath,
    error: anchorError,
  });

  if (insertError) {
    return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      ok: anchorError === null,
      ledgerSeq: latestRow.seq,
      chainHash: latestRow.chain_hash,
      githubCommitSha,
      githubPath: anchorPath,
      error: anchorError,
    },
    { status: anchorError === null ? 200 : 502 }
  );
}
