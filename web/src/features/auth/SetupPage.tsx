import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { AuthResponse } from '@pgforge/shared'
import { Button, Field, TextInput } from '../../components/ui/basics.js'
import { api, ApiError, applyAuth } from '../../lib/api.js'

export function SetupPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      applyAuth(await api<AuthResponse>('/api/auth/setup', { body: { name, email, password } }))
      navigate('/', { replace: true })
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
          <div className="auth-tagline">{t('auth.setupTitle')}</div>
          <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: '8px 0 0' }}>
            {t('auth.setupSub')}
          </p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <Field label={t('auth.yourName')}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </Field>
          <Field label={t('auth.email')}>
            <TextInput
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field label={t('auth.password')} error={error ?? undefined}>
            <TextInput
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Button variant="primary" type="submit" loading={busy}>
            {t('auth.createAccount')}
          </Button>
        </form>
      </div>
    </div>
  )
}
