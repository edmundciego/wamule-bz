import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Bot,
  ClipboardList,
  CreditCard,
  FileText,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Mail,
  Map,
  MessageSquare,
  Settings,
  Users,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Select, Textarea } from "../ui/Field";
import { ErrorState } from "../ui/State";
import { getSessionAndProfile } from "../../lib/data";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/utils";
import type { AppRole, DeveloperFeedbackPriority, DeveloperFeedbackType } from "../../types/database";

const navItems: Array<{ href: string; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean }> = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/briefs", label: "Daily Brief", icon: Bot },
  { href: "/emails", label: "Email Center", icon: Mail, adminOnly: true },
  { href: "/lots", label: "Lots", icon: Map },
  { href: "/applications", label: "Applications", icon: ClipboardList },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/contracts", label: "Contracts", icon: FileText },
  { href: "/payments", label: "Payments", icon: CreditCard },
  { href: "/collections", label: "Collections", icon: HandCoins },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

const feedbackTypes: DeveloperFeedbackType[] = ["Bug", "Question", "Feature Request", "Data Issue", "Other"];
const priorities: DeveloperFeedbackPriority[] = ["Low", "Normal", "High", "Urgent"];

export function AdminLayout() {
  const { data: sessionProfile } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
  });
  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const isAdmin = currentRole === "Super Admin" || currentRole === "Admin";
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<DeveloperFeedbackType>("Bug");
  const [priority, setPriority] = useState<DeveloperFeedbackPriority>("Normal");
  const [message, setMessage] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedbackError(null);
    setFeedbackMessage(null);
    setSubmitting(true);
    const { data, error } = await supabase.functions.invoke("submit-developer-feedback", {
      body: {
        feedback_type: feedbackType,
        priority,
        message,
        page_url: window.location.href,
      },
    });
    setSubmitting(false);
    if (error) {
      setFeedbackError(error.message);
      return;
    }
    if (data?.error) {
      setFeedbackError(String(data.error));
      return;
    }
    setMessage("");
    setFeedbackMessage(String(data?.message ?? "Feedback saved."));
  }

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="border-r border-primary/15 bg-primary text-primary-foreground">
        <div className="flex h-16 items-center gap-3 border-b border-white/15 px-5">
          <img
            src="/favicon/android-chrome-192x192.png"
            alt="Wamuale Development"
            className="h-11 w-11 rounded-md border border-copper/60 bg-ivory object-cover shadow-sm"
          />
          <div>
            <p className="font-display text-xl font-semibold leading-tight">Wamuale</p>
            <p className="text-xs uppercase tracking-[0.22em] text-white/65">Development</p>
          </div>
        </div>
        <nav className="grid gap-1 p-3">
          {navItems.filter((item) => !item.adminOnly || isAdmin).map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition",
                  isActive ? "bg-copper text-white" : "text-white/70 hover:bg-white/10 hover:text-white",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/15 p-3">
          <Button type="button" variant="ghost" className="w-full justify-start text-white hover:bg-white/10 hover:text-white" onClick={() => setFeedbackOpen(true)}>
            <MessageSquare className="h-4 w-4" />
            Send Feedback
          </Button>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-card/95 px-4 backdrop-blur lg:px-6">
          <p className="text-sm font-medium text-slate">Phase 1 lot management</p>
          <NavLink className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground" to="/logout">
            <LogOut className="h-4 w-4" />
            Logout
          </NavLink>
        </header>
        <main className="mx-auto max-w-7xl p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
      {feedbackOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4">
          <div className="w-full max-w-lg rounded-md border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-semibold text-primary">Send Feedback</h2>
                <p className="mt-1 text-sm text-muted-foreground">Submit a bug, question, data issue, or feature request to the developer.</p>
              </div>
              <Button type="button" variant="ghost" className="h-9 px-3" onClick={() => setFeedbackOpen(false)}>
                Close
              </Button>
            </div>
            <form className="mt-5 grid gap-4" onSubmit={(event) => void submitFeedback(event)}>
              {feedbackError ? <ErrorState message={feedbackError} /> : null}
              {feedbackMessage ? <div className="rounded-md border border-sage/30 bg-sage/15 p-3 text-sm text-primary">{feedbackMessage}</div> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Feedback type">
                  <Select value={feedbackType} onChange={(event) => setFeedbackType(event.target.value as DeveloperFeedbackType)}>
                    {feedbackTypes.map((type) => <option key={type}>{type}</option>)}
                  </Select>
                </Field>
                <Field label="Priority">
                  <Select value={priority} onChange={(event) => setPriority(event.target.value as DeveloperFeedbackPriority)}>
                    {priorities.map((level) => <option key={level}>{level}</option>)}
                  </Select>
                </Field>
              </div>
              <Field label="Message">
                <Textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe what happened or what you need." />
              </Field>
              <p className="break-all text-xs text-muted-foreground">Page captured: {window.location.href}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setFeedbackOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={submitting || !message.trim()}>
                  <MessageSquare className="h-4 w-4" />
                  {submitting ? "Submitting..." : "Submit Feedback"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
