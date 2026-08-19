import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MIN_PASSWORD_LENGTH, type AuthResponse, type InvitationPreview } from '@pgforge/shared'
import { Button, Field, TextInput } from '../../components/ui/basics.js'
import { api, ApiError, applyAuth } from '../../lib/api.js'

/** Public page reached from a one-time invitation link: /invite/:token */
export function InvitePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token = '' } = useParams<{ token: string }>()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () => api<InvitationPreview>(`/api/invitations/${encodeURIComponent(token)}`),
    staleTime: 0,
    retry: false,
  })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      applyAuth(await api<AuthResponse>('/api/invitations/accept', { body: { token, name, password } }))
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  const invalidMessage = (reason: InvitationPreview['reason']) =>
    reason === 'used'
      ? t('auth.inviteUsed')
      : reason === 'expired'
        ? t('auth.inviteExpired')
        : reason === 'revoked'
          ? t('auth.inviteRevoked')
          : t('auth.inviteInvalid')

  const roleLabel = (role: string) =>
    t(role === 'admin' ? 'settings.roleAdmin' : role === 'editor' ? 'settings.roleEditor' : 'settings.roleViewer')

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div>
          <div className="auth-brand">
            pg<span className="accent">forge</span>
          </div>
          <div className="auth-tagline">{t('auth.inviteTitle')}</div>
        </div>

        {preview.isLoading && (
          <div className="auth-form" style={{ alignItems: 'center' }}>
            <span className="spinner" />
          </div>
        )}

        {preview.data && !preview.data.valid && (
          <div className="auth-form">
            <div className="text-danger" style={{ fontSize: 'var(--text-sm)' }}>
              {invalidMessage(preview.data.reason)}
            </div>
            <Link to="/login" className="btn btn-outline" style={{ alignSelf: 'flex-start' }}>
              {t('auth.goToLogin')}
            </Link>
          </div>
        )}

        {preview.data?.valid && (
          <form className="auth-form" onSubmit={submit}>
            <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
              {t('auth.inviteSub', { role: roleLabel(preview.data.role ?? 'viewer') })}
            </p>
            <Field label={t('auth.email')}>
              <TextInput mono value={preview.data.email ?? ''} disabled />
            </Field>
            <Field label={t('auth.yourName')}>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
            </Field>
            <Field label={t('auth.password')} error={error ?? undefined}>
              <TextInput
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <Button variant="primary" type="submit" loading={busy}>
              {t('auth.createAccount')}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
