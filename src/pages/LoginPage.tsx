import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
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
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Admin Login</CardTitle>
          <p className="text-sm text-muted-foreground">Sign in with your Wamuale staff account.</p>
        </CardHeader>
        <CardContent>
          {!hasSupabaseConfig ? (
            <ErrorState message="Supabase environment variables are missing." />
          ) : (
            <form className="grid gap-4" onSubmit={onSubmit}>
              {error ? <ErrorState message={error} /> : null}
              <Field label="Email">
                <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </Field>
              <Field label="Password">
                <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </Field>
              <Button disabled={loading}>{loading ? "Signing in..." : "Sign in"}</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
