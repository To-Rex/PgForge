import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import type { AuthResponse, BootstrapInfo } from '@pgforge/shared'
import { Button, Field, TextInput } from '../../components/ui/basics.js'
import { api, ApiError, applyAuth } from '../../lib/api.js'
import { useAuthStore } from '../../stores/auth.js'

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<BootstrapInfo>('/api/auth/bootstrap'),
    staleTime: 0,
  })

  if (user) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from ?? '/'} replace />
  }
  if (bootstrap.data?.needsSetup) {
    return <Navigate to="/setup" replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      applyAuth(await api<AuthResponse>('/api/auth/login', { body: { email, password } }))
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div>
          <div className="auth-brand">
            pg<span className="accent">forge</span>
          </div>
          <div className="auth-tagline">{t('auth.tagline')}</div>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <Field label={t('auth.email')}>
            <TextInput
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </Field>
          <Field label={t('auth.password')} error={error ?? undefined}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Button variant="primary" type="submit" loading={busy}>
            {t('auth.signIn')}
          </Button>
        </form>
      </div>
    </div>
  )
}
