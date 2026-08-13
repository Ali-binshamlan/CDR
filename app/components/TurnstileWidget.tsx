"use client";

import { useEffect, useRef, useState } from "react";

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "محدد
// المعدل غير موزع ومسار التسجيل يحتاج إعادة ضبط"، بند: "CAPTCHA للتسجيل
// العام"): ودجت Cloudflare Turnstile — يُرسِل الرمز الناتج (token) إلى
// الخادم (auth/register/route.ts) عبر حقل captchaToken، حيث يتحقق منه
// app/lib/captcha.ts فعلياً باستخدام TURNSTILE_SECRET_KEY.
//
// سكربت Turnstile يُحمَّل مباشرة من api.js (لا حزمة npm إضافية — الودجت
// بسيطة بما يكفي لتبرير تجنّب تبعية كاملة لعنصر واحد). NEXT_PUBLIC_
// TURNSTILE_SITE_KEY علني بتصميم Turnstile نفسه (site key ليس سرّاً — نظير
// reCAPTCHA site key، يظهر في HTML الصفحة دائماً).
declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
        }
      ) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

let scriptLoadPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('فشل تحميل سكربت Turnstile'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

export function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    // بلا site key مُعرَّف: لا نعرض الودجت إطلاقاً (بدل خطأ مربك للمستخدم) —
    // الخادم نفسه fail-open في هذه الحالة (captcha.ts، TURNSTILE_SECRET_KEY
    // غائب أيضاً)، فلا حاجة لإجبار الواجهة على عرض شيء لا يتحقق منه أحد.
    if (!siteKey) return;

    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token: string) => onToken(token),
          'error-callback': () => {
            onToken(null);
            setLoadError('تعذّر التحقق — الرجاء إعادة تحميل الصفحة');
          },
          'expired-callback': () => onToken(null),
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (!siteKey) return null;

  return (
    <div className="space-y-1">
      <div ref={containerRef} />
      {loadError && <p className="text-red-500 text-xs font-bold px-1">{loadError}</p>}
    </div>
  );
}
