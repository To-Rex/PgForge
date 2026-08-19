import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button, Field, TextInput } from '../../components/ui/basics.js'
import { Modal } from '../../components/ui/overlays.js'
import { api, ApiError, setAccessToken } from '../../lib/api.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'

const CONFIRM_PHRASE = 'RESET'

export function DangerPanel() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const reset = useMutation({
    mutationFn: () => api('/api/system/factory-reset', { body: { password, confirm } }),
    onSuccess: () => {
      // Everything server-side is gone, including our own session.
      setAccessToken(null)
      useAuthStore.getState().clear()
      queryClient.clear()
      try {
        localStorage.clear()
      } catch {
        /* ignore */
      }
      toast.info(t('settings.factoryResetDone'))
      navigate('/setup', { replace: true })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <div className="panel" style={{ borderColor: 'var(--danger)' }}>
      <div className="panel-header" style={{ color: 'var(--danger)' }}>
        <span className="row">
          <AlertTriangle size={15} />
          {t('settings.danger')}
        </span>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 600 }}>{t('settings.factoryReset')}</div>
        <div className="muted" style={{ fontSize: 'var(--text-sm)', maxWidth: 760 }}>
          {t('settings.factoryResetHint')}
        </div>
        <Button
          variant="danger-outline"
          icon={AlertTriangle}
          onClick={() => setOpen(true)}
          style={{ alignSelf: 'flex-start' }}
        >
          {t('settings.factoryResetButton')}
        </Button>
      </div>

      {open && (
        <Modal
          title={t('settings.factoryResetConfirmTitle')}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={!password || confirm !== CONFIRM_PHRASE}
                loading={reset.isPending}
                onClick={() => reset.mutate()}
              >
                {t('settings.factoryResetButton')}
              </Button>
            </>
          }
        >
          <div className="text-danger" style={{ fontSize: 'var(--text-sm)' }}>
            {t('settings.factoryResetWarning')}
          </div>
          <Field label={t('settings.yourPassword')}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label={t('settings.typeReset')}>
            <TextInput mono value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={CONFIRM_PHRASE} />
          </Field>
        </Modal>
      )}
    </div>
  )
}
