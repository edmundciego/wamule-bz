import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, LockKeyhole, Map, ReceiptText, ShieldCheck } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { ErrorState } from "../components/ui/State";
import { hasSupabaseConfig, supabase } from "../lib/supabase";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (loginError) {
      setError(loginError.message);
      return;
    }
    navigate("/dashboard");
  }

  return (
    <main className="min-h-screen bg-ivory">
      <div className="mx-auto grid min-h-screen max-w-6xl items-center gap-8 px-4 py-8 lg:grid-cols-[1fr_440px] lg:px-8">
        <section className="overflow-hidden rounded-lg border border-primary/15 bg-primary text-white shadow-xl shadow-primary/10">
          <div className="brand-pattern h-4 border-b border-white/10 opacity-90" />
          <div className="grid gap-8 p-6 sm:p-8 lg:p-10">
            <div className="flex items-center gap-4">
              <img
                src="/favicon/android-chrome-192x192.png"
                alt="Wamuale Development"
                className="h-16 w-16 rounded-md border border-copper/70 bg-ivory object-cover shadow-sm"
              />
              <div>
                <p className="font-display text-3xl font-semibold leading-tight">Wamuale</p>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-copper">Development</p>
              </div>
            </div>

            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-copper">Admin Workspace</p>
              <h1 className="mt-4 max-w-2xl font-display text-5xl font-semibold tracking-normal sm:text-6xl">
                Land, payments, and collections in one secure place.
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-6 text-white/70">
                Staff access for Phase 1 lot management, applications, contracts, receipt tracking, and account follow-up.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <LoginFeature icon={Map} label="Lots" detail="Phase 1 status" />
              <LoginFeature icon={ReceiptText} label="Payments" detail="Receipts & proofs" />
              <LoginFeature icon={ShieldCheck} label="Controls" detail="Admin settings" />
            </div>
          </div>
        </section>

        <section className="rounded-lg border bg-card p-6 shadow-xl shadow-primary/10 sm:p-8">
          <div className="mb-7">
            <div className="mb-4 grid h-11 w-11 place-items-center rounded-md bg-copper/10 text-copper">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-copper">Secure Sign In</p>
            <h2 className="mt-3 font-display text-3xl font-semibold text-primary">Admin Login</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Sign in with your Wamuale staff account to continue.
            </p>
          </div>

          {!hasSupabaseConfig ? (
            <ErrorState message="Supabase environment variables are missing." />
          ) : (
            <form className="grid gap-4" onSubmit={onSubmit}>
              {error ? <ErrorState message={error} /> : null}
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  placeholder="staff@wamuale.com"
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="Enter password"
                />
              </Field>
              <Button className="mt-2 w-full" disabled={loading}>
                {loading ? "Signing in..." : (
                  <>
                    Sign in <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          )}

          <div className="mt-7 border-t pt-5 text-xs leading-5 text-muted-foreground">
            Protected access only. Contact an administrator if your staff account has not been created.
          </div>
        </section>
      </div>
    </main>
  );
}

function LoginFeature({
  icon: Icon,
  label,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/5 p-4">
      <Icon className="h-5 w-5 text-copper" />
      <p className="mt-3 text-sm font-semibold">{label}</p>
      <p className="mt-1 text-xs text-white/60">{detail}</p>
    </div>
  );
}
