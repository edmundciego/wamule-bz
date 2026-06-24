import { Navigate, Route, Routes } from "react-router-dom";
import { AdminLayout } from "./components/layout/AdminLayout";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
import { ApplicationPage } from "./pages/ApplicationPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { AuditTrailPage } from "./pages/AuditTrailPage";
import { ContractsPage } from "./pages/ContractsPage";
import { CollectionsPage } from "./pages/CollectionsPage";
import { CustomerDetailPage } from "./pages/CustomerDetailPage";
import { CustomersPage } from "./pages/CustomersPage";
import { DailyBriefsPage } from "./pages/DailyBriefsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DocumentPage } from "./pages/DocumentPage";
import { EmailsPage } from "./pages/EmailsPage";
import { LoginPage } from "./pages/LoginPage";
import { LotsPage } from "./pages/LotsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { LogoutPage } from "./pages/LogoutPage";
import { PaymentsPage } from "./pages/PaymentsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ApplicationPage />} />
      <Route path="/apply" element={<ApplicationPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/logout" element={<LogoutPage />} />
      <Route path="/admin" element={<Navigate to="/dashboard" replace />} />
      <Route
        path="/documents/:kind/:id"
        element={
          <ProtectedRoute>
            <DocumentPage />
          </ProtectedRoute>
        }
      />
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
  );
}
