import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Mail, RotateCw, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppRole, CreatedInvitation, Invitation } from '@pgforge/shared'
import { Badge, Button, EmptyState, Field, Select, TextInput } from '../../components/ui/basics.js'
import { api, ApiError } from '../../lib/api.js'
import { formatDate } from '../../lib/format.js'
import { toast } from '../../stores/toast.js'

export function InvitesPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AppRole>('viewer')
  const [lastCreated, setLastCreated] = useState<CreatedInvitation | null>(null)

  const invites = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api<Invitation[]>('/api/invitations'),
  })

  const create = useMutation({
    mutationFn: (input: { email: string; role: AppRole }) =>
      api<CreatedInvitation>('/api/invitations', { body: input }),
    onSuccess: (created) => {
      setLastCreated(created)
      setEmail('')
      void queryClient.invalidateQueries({ queryKey: ['invitations'] })
      if (created.emailSent) toast.ok(t('settings.inviteEmailSent', { email: created.invitation.email }))
      else toast.info(created.emailError ? t('settings.inviteEmailFailed') : t('settings.inviteEmailNotConfigured'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['invitations'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const statusKind = (status: Invitation['status']) =>
    status === 'accepted' ? 'ok' : status === 'pending' ? 'accent' : status === 'expired' ? 'warn' : 'muted'

  const roleLabel = (r: AppRole) =>
    t(r === 'admin' ? 'settings.roleAdmin' : r === 'editor' ? 'settings.roleEditor' : 'settings.roleViewer')

  return (
    <div className="panel">
      <div className="panel-header">{t('settings.invites')}</div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          {t('settings.inviteHint')}
        </div>
        <form
          className="row"
          style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault()
            if (email) create.mutate({ email, role })
          }}
        >
          <div className="grow" style={{ minWidth: 220 }}>
            <Field label={t('auth.email')}>
              <TextInput
                type="email"
                mono
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@example.com"
                required
              />
            </Field>
          </div>
          <div style={{ width: 160 }}>
            <Field label={t('settings.role')}>
              <Select value={role} onChange={(e) => setRole(e.target.value as AppRole)}>
                <option value="viewer">{t('settings.roleViewer')}</option>
                <option value="editor">{t('settings.roleEditor')}</option>
                <option value="admin">{t('settings.roleAdmin')}</option>
              </Select>
            </Field>
          </div>
          <Button variant="primary" icon={Mail} type="submit" loading={create.isPending} disabled={!email}>
            {t('settings.sendInvite')}
          </Button>
        </form>

        {lastCreated && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              background: 'var(--bg-sunken)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div className="field-label">
              {t('settings.inviteLink')} — <span className="mono">{lastCreated.invitation.email}</span>
            </div>
            <div className="row">
              <TextInput mono readOnly value={lastCreated.acceptUrl} onFocus={(e) => e.currentTarget.select()} />
              <Button
                size="sm"
                icon={Copy}
                onClick={() => {
                  void navigator.clipboard.writeText(lastCreated.acceptUrl)
                  toast.ok(t('common.copied'))
                }}
              >
                {t('common.copy')}
              </Button>
            </div>
            {!lastCreated.emailSent && (
              <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                {lastCreated.emailError
                  ? `${t('settings.inviteEmailFailed')} (${lastCreated.emailError})`
                  : t('settings.inviteEmailNotConfigured')}
              </div>
            )}
          </div>
        )}
      </div>

      {invites.data?.length === 0 ? (
        <EmptyState icon={Mail} title={t('settings.noInvites')} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('auth.email')}</th>
              <th>{t('settings.role')}</th>
              <th>{t('common.status')}</th>
              <th>{t('settings.expires')}</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {invites.data?.map((invite) => (
              <tr key={invite.id}>
                <td className="mono">{invite.email}</td>
                <td>{roleLabel(invite.role)}</td>
                <td>
                  <Badge kind={statusKind(invite.status)}>{t(`settings.inviteStatus_${invite.status}`)}</Badge>
                </td>
                <td className="mono muted">
                  {invite.status === 'accepted' ? formatDate(invite.acceptedAt) : formatDate(invite.expiresAt)}
                </td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                    {invite.status !== 'accepted' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={RotateCw}
                        aria-label={t('settings.reinvite')}
                        title={t('settings.reinvite')}
                        onClick={() => create.mutate({ email: invite.email, role: invite.role })}
                      />
                    )}
                    {invite.status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={X}
                        aria-label={t('settings.revokeInvite')}
                        title={t('settings.revokeInvite')}
                        onClick={() => revoke.mutate(invite.id)}
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
