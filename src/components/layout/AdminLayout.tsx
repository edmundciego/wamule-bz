import { NavLink, Outlet } from "react-router-dom";
import {
  BarChart3,
  ClipboardList,
  CreditCard,
  FileText,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Map,
  Settings,
  Users,
} from "lucide-react";
import { cn } from "../../lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/lots", label: "Lots", icon: Map },
  { href: "/applications", label: "Applications", icon: ClipboardList },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/contracts", label: "Contracts", icon: FileText },
  { href: "/payments", label: "Payments", icon: CreditCard },
  { href: "/collections", label: "Collections", icon: HandCoins },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AdminLayout() {
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
          {navItems.map((item) => (
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
    </div>
  );
}
