import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { WorkspaceScopeBoundary } from "./components/auth/WorkspaceScopeBoundary";
import { featureFlags } from "./lib/featureFlags";
import { isHopkinsPublicHost } from "./lib/publicHosts";
import { PublicExperienceRoute } from "./pages/public/PublicExperienceRoute";

const AdminLayout = lazy(() =>
  import("./components/layout/AdminLayout").then((module) => ({ default: module.AdminLayout })),
);
const ProtectedRoute = lazy(() =>
  import("./components/layout/ProtectedRoute").then((module) => ({ default: module.ProtectedRoute })),
);
const ApplicationsPage = lazy(() =>
  import("./pages/ApplicationsPage").then((module) => ({ default: module.ApplicationsPage })),
);
const AuditTrailPage = lazy(() =>
  import("./pages/AuditTrailPage").then((module) => ({ default: module.AuditTrailPage })),
);
const ContractsPage = lazy(() =>
  import("./pages/ContractsPage").then((module) => ({ default: module.ContractsPage })),
);
const CollectionsPage = lazy(() =>
  import("./pages/CollectionsPage").then((module) => ({ default: module.CollectionsPage })),
);
const CorrectionWorkspacePage = lazy(() =>
  import("./pages/CorrectionWorkspacePage").then((module) => ({ default: module.CorrectionWorkspacePage })),
);
const CustomerDetailPage = lazy(() =>
  import("./pages/CustomerDetailPage").then((module) => ({ default: module.CustomerDetailPage })),
);
const CustomersPage = lazy(() =>
  import("./pages/CustomersPage").then((module) => ({ default: module.CustomersPage })),
);
const DailyBriefsPage = lazy(() =>
  import("./pages/DailyBriefsPage").then((module) => ({ default: module.DailyBriefsPage })),
);
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })),
);
const DocumentPage = lazy(() =>
  import("./pages/DocumentPage").then((module) => ({ default: module.DocumentPage })),
);
const EmailsPage = lazy(() =>
  import("./pages/EmailsPage").then((module) => ({ default: module.EmailsPage })),
);
const InformationCenterPage = lazy(() =>
  import("./pages/InformationCenterPage").then((module) => ({ default: module.InformationCenterPage })),
);
const InformationPackDocumentPage = lazy(() =>
  import("./pages/InformationPackDocumentPage").then((module) => ({ default: module.InformationPackDocumentPage })),
);
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const EmbeddableMapPage = lazy(() =>
  import("./pages/public/EmbeddableMapPage").then((module) => ({ default: module.EmbeddableMapPage })),
);
const HopkinsPublicPage = lazy(() =>
  import("./pages/public/HopkinsPublicPage").then((module) => ({ default: module.HopkinsPublicPage })),
);
const PublicVersionPage = lazy(() =>
  import("./pages/public/PublicVersionPage").then((module) => ({ default: module.PublicVersionPage })),
);
const LotsPage = lazy(() => import("./pages/LotsPage").then((module) => ({ default: module.LotsPage })));
const LeadsPage = lazy(() => import("./pages/LeadsPage").then((module) => ({ default: module.LeadsPage })));
const LogoutPage = lazy(() => import("./pages/LogoutPage").then((module) => ({ default: module.LogoutPage })));
const PaymentsPage = lazy(() => import("./pages/PaymentsPage").then((module) => ({ default: module.PaymentsPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((module) => ({ default: module.ReportsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

export default function App() {
  const hostHomepage = isHopkinsPublicHost(window.location.hostname);
  const publicHomepage = <PublicExperienceRoute scopeName={hostHomepage ? "hopkins" : "wamule"} />;
  return (
    <Suspense fallback={<div role="status" aria-live="polite">Loading…</div>}>
      <Routes>
        <Route path="/" element={publicHomepage} />
        <Route path="/version" element={<PublicVersionPage />} />
        <Route path="/apply" element={hostHomepage ? <HopkinsPublicPage /> : <PublicExperienceRoute scopeName="wamule" />} />
        <Route path="/hopkins" element={<HopkinsPublicPage />} />
        <Route path="/hopkins/apply" element={<HopkinsPublicPage />} />
        <Route path="/hopkins/application" element={<HopkinsPublicPage />} />
        <Route path="/embed/:tenant_slug" element={<EmbeddableMapPage />} />
        <Route path="/embed/:tenant_slug/:project_slug" element={<EmbeddableMapPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/logout" element={<LogoutPage />} />
        {/* Slice 1.5 workspace: DEV ?demo=1 fixture mode is compiled out of
            production builds; every other path enforces session + profile
            inside the page (mirrors EmbeddableMapPage's demo contract). */}
        <Route path="/lots/correct" element={<CorrectionWorkspacePage />} />
        <Route path="/admin" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/documents/:kind/:id"
          element={
            <ProtectedRoute>
              <WorkspaceScopeBoundary><DocumentPage /></WorkspaceScopeBoundary>
            </ProtectedRoute>
          }
        />
        {featureFlags.informationCentre ? (
          <Route
            path="/information-packs/:id/print"
            element={
              <ProtectedRoute>
                <WorkspaceScopeBoundary><InformationPackDocumentPage /></WorkspaceScopeBoundary>
              </ProtectedRoute>
            }
          />
        ) : null}
        <Route
          element={
            <ProtectedRoute>
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/briefs" element={<DailyBriefsPage />} />
          <Route path="/emails" element={<EmailsPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          {featureFlags.informationCentre ? (
            <Route path="/information-centre" element={<InformationCenterPage />} />
          ) : null}
          <Route path="/lots" element={<LotsPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/contracts/:id" element={<ContractsPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/audit-trail" element={<AuditTrailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
