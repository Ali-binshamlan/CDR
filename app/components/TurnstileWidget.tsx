"use client";

import { useEffect, useRef, useState } from "react";

// Detected and fixed bug (explicit user request — external code review: "Rate limiter
// is not distributed and registration path needs reset", item: "CAPTCHA for public
// registration"): Cloudflare Turnstile widget — sends the generated token to the server
// (auth/register/route.ts) via the captchaToken field, where app/lib/captcha.ts validates it
// using TURNSTILE_SECRET_KEY.
//
// Turnstile script is loaded directly from api.js (no extra npm package needed — the widget
// is simple enough to justify avoiding a full package dependency for a single element).
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is public by Turnstile's design (site key is not secret — equivalent
// to reCAPTCHA site key, it always appears in the page's HTML).
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
    script.onerror = () => reject(new Error('Failed to load Turnstile script'));
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
    // Without a defined site key: do not render the widget at all (instead of confusing the user with an error) —
    // the server itself is fail-open in this scenario (captcha.ts, TURNSTILE_SECRET_KEY is also missing),
    // so there is no need to force the UI to render something that no one is validating.
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
            setLoadError('Verification failed — please reload the page');
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