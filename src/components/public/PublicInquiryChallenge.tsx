import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render(target: HTMLElement, options: {
    sitekey: string;
    action: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>("script[data-wamule-turnstile]");
    let appendScript = false;
    if (!script) {
      script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.wamuleTurnstile = "true";
      appendScript = true;
    }
    script.addEventListener("load", () => window.turnstile ? resolve() : reject(new Error("Turnstile API unavailable.")), { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile script failed to load.")), { once: true });
    if (appendScript) document.head.append(script);
  }).catch((error: unknown) => {
    turnstileScriptPromise = null;
    throw error;
  });
  return turnstileScriptPromise;
}

export function PublicInquiryChallenge({
  token,
  resetCount,
  onToken,
}: {
  token: string | null;
  resetCount: number;
  onToken: (token: string | null) => void;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? "";

  useEffect(() => {
    if (!siteKey || !targetRef.current) return;
    let active = true;
    void loadTurnstileScript().then(() => {
      if (!active || !targetRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(targetRef.current, {
        sitekey: siteKey,
        action: "public_inquiry",
        callback: (verifiedToken) => {
          setError(null);
          onToken(verifiedToken);
        },
        "expired-callback": () => onToken(null),
        "error-callback": () => {
          onToken(null);
          setError("The security check could not be completed. Please reload it and try again.");
        },
      });
    }).catch(() => {
      if (active) setError("The security check could not load. Please try again later.");
    });

    return () => {
      active = false;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [onToken, siteKey]);

  useEffect(() => {
    if (resetCount > 0 && widgetIdRef.current && window.turnstile) {
      setError(null);
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [resetCount]);

  return (
    <div className="grid gap-2" role="group" aria-label="Security check" aria-describedby="inquiry-security-status">
      {siteKey ? <div ref={targetRef} /> : null}
      <p id="inquiry-security-status" className="text-xs text-muted-foreground" role={error || !siteKey ? "alert" : "status"}>
        {error ?? (!siteKey ? "The security check is not configured. Please try again later." : token ? "Security check complete." : "Complete the security check to send your inquiry.")}
      </p>
    </div>
  );
}
