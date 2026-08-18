import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DeliveryChannel,
  DeliverySettings,
  DeliveryTestResult,
  SmtpSecurity,
  TelegramBotInfo,
} from '@pgforge/shared'
import { Badge, Button, Checkbox, Field, Select, TextInput } from '../../components/ui/basics.js'
import { api, ApiError } from '../../lib/api.js'
import { toast } from '../../stores/toast.js'

interface FormState {
  telegram: { enabled: boolean; botToken: string; chatId: string }
  email: {
    enabled: boolean
    host: string
    port: number
    security: SmtpSecurity
    username: string
    password: string
    from: string
    to: string
  }
  yandex: { enabled: boolean; token: string; folder: string }
  autoSend: boolean
}

const fromSettings = (s: DeliverySettings): FormState => ({
  telegram: { enabled: s.telegram.enabled, botToken: '', chatId: s.telegram.chatId },
  email: {
    enabled: s.email.enabled,
    host: s.email.host,
    port: s.email.port,
    security: s.email.security,
    username: s.email.username,
    password: '',
    from: s.email.from,
    to: s.email.to,
  },
  yandex: { enabled: s.yandex.enabled, token: '', folder: s.yandex.folder },
  autoSend: s.autoSend,
})

export function DeliveryPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState | null>(null)
  const [testing, setTesting] = useState<DeliveryChannel | null>(null)

  const settings = useQuery({
    queryKey: ['delivery-settings'],
    queryFn: () => api<DeliverySettings>('/api/delivery/settings'),
  })

  const botInfo = useQuery({
    queryKey: ['telegram-info'],
    queryFn: () => api<TelegramBotInfo>('/api/delivery/telegram-info'),
    enabled: settings.data?.telegram.botTokenSet ?? false,
  })

  useEffect(() => {
    if (settings.data && form === null) setForm(fromSettings(settings.data))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data])

  const save = useMutation({
    mutationFn: (state: FormState) =>
      api<DeliverySettings>('/api/delivery/settings', {
        method: 'PUT',
        body: {
          telegram: {
            enabled: state.telegram.enabled,
            botToken: state.telegram.botToken || undefined,
            chatId: state.telegram.chatId,
          },
          email: { ...state.email, password: state.email.password || undefined },
          yandex: {
            enabled: state.yandex.enabled,
            token: state.yandex.token || undefined,
            folder: state.yandex.folder,
          },
          autoSend: state.autoSend,
        },
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['delivery-settings'], saved)
      setForm(fromSettings(saved))
      void queryClient.invalidateQueries({ queryKey: ['delivery-channels'] })
      void queryClient.invalidateQueries({ queryKey: ['telegram-info'] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const runTest = async (channel: DeliveryChannel) => {
    if (!form) return
    setTesting(channel)
    try {
      await save.mutateAsync(form)
      const result = await api<DeliveryTestResult>('/api/delivery/test', { body: { channel } })
      if (result.ok) toast.ok(result.detail ? `${t('common.success')} — ${result.detail}` : t('common.success'))
      else toast.error(result.error ?? t('errors.generic'))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('errors.generic'))
    } finally {
      setTesting(null)
    }
  }

  if (!form) {
    return (
      <div className="panel">
        <div className="panel-header">{t('delivery.title')}</div>
        <div className="row" style={{ padding: 16, justifyContent: 'center' }}>
          <span className="spinner" />
        </div>
      </div>
    )
  }

  const patch = (updater: (draft: FormState) => void) => {
    setForm((prev) => {
      if (!prev) return prev
      const draft = structuredClone(prev)
      updater(draft)
      return draft
    })
  }

  const secretPlaceholder = (isSet: boolean) => (isSet ? t('delivery.secretStored') : undefined)

  return (
    <div className="panel">
      <div className="panel-header">
        {t('delivery.title')}
        <Button
          size="sm"
          variant="primary"
          loading={save.isPending && testing === null}
          onClick={() => {
            save.mutate(form, { onSuccess: () => toast.ok(t('common.success')) })
          }}
        >
          {t('common.save')}
        </Button>
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          {t('delivery.hint')}
        </div>

        {/* ── Telegram ─────────────────────────────────────────────────── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="row">
            <Checkbox
              label={<strong>{t('delivery.telegram')}</strong>}
              checked={form.telegram.enabled}
              onChange={(v) => patch((d) => (d.telegram.enabled = v))}
            />
            {botInfo.isFetching && <span className="spinner" />}
            {botInfo.data?.ok && botInfo.data.username && (
              <Badge kind="ok">@{botInfo.data.username}</Badge>
            )}
            {botInfo.data && !botInfo.data.ok && (
              <span title={botInfo.data.error}>
                <Badge kind="danger">{t('delivery.botError')}</Badge>
              </span>
            )}
            <span className="grow" />
            <Button size="sm" icon={Send} loading={testing === 'telegram'} onClick={() => void runTest('telegram')}>
              {t('delivery.test')}
            </Button>
          </div>
          <div className="form-grid">
            <Field label={t('delivery.botToken')}>
              <TextInput
                mono
                type="password"
                autoComplete="off"
                placeholder={secretPlaceholder(settings.data?.telegram.botTokenSet ?? false)}
                value={form.telegram.botToken}
                onChange={(e) => patch((d) => (d.telegram.botToken = e.target.value))}
              />
            </Field>
            <Field label={t('delivery.chatId')} hint={t('delivery.chatIdHint')}>
              <TextInput
                mono
                value={form.telegram.chatId}
                onChange={(e) => patch((d) => (d.telegram.chatId = e.target.value))}
              />
            </Field>
          </div>
        </section>

        {/* ── Email ────────────────────────────────────────────────────── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="row">
            <Checkbox
              label={<strong>{t('delivery.email')}</strong>}
              checked={form.email.enabled}
              onChange={(v) => patch((d) => (d.email.enabled = v))}
            />
            <span className="grow" />
            <Button size="sm" icon={Send} loading={testing === 'email'} onClick={() => void runTest('email')}>
              {t('delivery.test')}
            </Button>
          </div>
          <div className="form-grid">
            <Field label={t('delivery.host')}>
              <TextInput
                mono
                placeholder="smtp.gmail.com"
                value={form.email.host}
                onChange={(e) => patch((d) => (d.email.host = e.target.value))}
              />
            </Field>
            <div className="row" style={{ gap: 12 }}>
              <Field label={t('delivery.port')}>
                <TextInput
                  mono
                  type="number"
                  value={form.email.port}
                  onChange={(e) => patch((d) => (d.email.port = Number(e.target.value)))}
                  style={{ width: 90 }}
                />
              </Field>
              <div className="grow">
                <Field label={t('delivery.security')}>
                  <Select
                    value={form.email.security}
                    onChange={(e) => patch((d) => (d.email.security = e.target.value as SmtpSecurity))}
                  >
                    <option value="starttls">STARTTLS</option>
                    <option value="ssl">SSL/TLS</option>
                    <option value="none">—</option>
                  </Select>
                </Field>
              </div>
            </div>
            <Field label={t('delivery.username')}>
              <TextInput
                mono
                autoComplete="off"
                value={form.email.username}
                onChange={(e) => patch((d) => (d.email.username = e.target.value))}
              />
            </Field>
            <Field label={t('conn.password')}>
              <TextInput
                mono
                type="password"
                autoComplete="new-password"
                placeholder={secretPlaceholder(settings.data?.email.passwordSet ?? false)}
                value={form.email.password}
                onChange={(e) => patch((d) => (d.email.password = e.target.value))}
              />
            </Field>
            <Field label={t('delivery.from')}>
              <TextInput
                mono
                placeholder="backups@example.com"
                value={form.email.from}
                onChange={(e) => patch((d) => (d.email.from = e.target.value))}
              />
            </Field>
            <Field label={t('delivery.to')} hint={t('delivery.toHint')}>
              <TextInput
                mono
                value={form.email.to}
                onChange={(e) => patch((d) => (d.email.to = e.target.value))}
              />
            </Field>
          </div>
        </section>

        {/* ── Yandex Disk ──────────────────────────────────────────────── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="row">
            <Checkbox
              label={<strong>{t('delivery.yandex')}</strong>}
              checked={form.yandex.enabled}
              onChange={(v) => patch((d) => (d.yandex.enabled = v))}
            />
            <span className="grow" />
            <Button size="sm" icon={Send} loading={testing === 'yandex'} onClick={() => void runTest('yandex')}>
              {t('delivery.test')}
            </Button>
          </div>
          <div className="form-grid">
            <Field label={t('delivery.token')}>
              <TextInput
                mono
                type="password"
                autoComplete="off"
                placeholder={secretPlaceholder(settings.data?.yandex.tokenSet ?? false)}
                value={form.yandex.token}
                onChange={(e) => patch((d) => (d.yandex.token = e.target.value))}
              />
            </Field>
            <Field label={t('delivery.folder')}>
              <TextInput
                mono
                value={form.yandex.folder}
                onChange={(e) => patch((d) => (d.yandex.folder = e.target.value))}
              />
            </Field>
          </div>
        </section>

        <Checkbox
          label={t('delivery.autoSend')}
          checked={form.autoSend}
          onChange={(v) => patch((d) => (d.autoSend = v))}
        />
      </div>
    </div>
  )
}
