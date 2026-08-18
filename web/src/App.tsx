import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ErrorBoundary } from './components/ui/ErrorBoundary.js'
import { Toasts } from './components/ui/Toasts.js'
import { AppShell } from './components/layout/AppShell.js'
import { ApiError, bootstrapSession } from './lib/api.js'
import { AuditPage } from './features/audit/AuditPage.js'
import { LoginPage } from './features/auth/LoginPage.js'
import { SetupPage } from './features/auth/SetupPage.js'
import { BackupInspectPage } from './features/backups/BackupInspectPage.js'
import { BackupsPage } from './features/backups/BackupsPage.js'
import { ExplorerPage } from './features/explorer/ExplorerPage.js'
import { ErdPage } from './features/erd/ErdPage.js'
import { HomePage } from './features/home/HomePage.js'
import { MonitorPage } from './features/monitor/MonitorPage.js'
import { OverviewPage } from './features/overview/OverviewPage.js'
import { RolesPage } from './features/roles/RolesPage.js'
import { SettingsPage } from './features/settings/SettingsPage.js'
import { SqlPage } from './features/sql/SqlPage.js'
import { WorkspaceLayout } from './features/workspace/WorkspaceLayout.js'
import { useAuthStore } from './stores/auth.js'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status > 0 && error.status < 500) return false
        return failureCount < 2
      },
      refetchOnWindowFocus: false,
    },
  },
})

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuthStore()
  const location = useLocation()
  if (!ready) {
    return (
      <div className="auth-screen">
        <span className="spinner" />
      </div>
    )
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }
  return <>{children}</>
}

export function App() {
  useEffect(() => {
    void bootstrapSession()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/" element={<HomePage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/c/:connId" element={<WorkspaceLayout />}>
              <Route index element={<OverviewPage />} />
              <Route path="explorer" element={<ExplorerPage />} />
              <Route path="sql" element={<SqlPage />} />
              <Route path="erd" element={<ErdPage />} />
              <Route path="monitor" element={<MonitorPage />} />
              <Route path="roles" element={<RolesPage />} />
              <Route path="backups" element={<BackupsPage />} />
              <Route path="backups/:backupId" element={<BackupInspectPage />} />
            </Route>
          </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
      <Toasts />
    </QueryClientProvider>
  )
}
