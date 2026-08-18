import type { LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'danger-outline'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: LucideIcon
  loading?: boolean
}

export function Button({
  variant = 'outline',
  size = 'md',
  icon: Icon,
  loading,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : '',
    !children ? 'btn-icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const iconSize = size === 'sm' ? 13 : 15
  return (
    <button type="button" className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" /> : Icon ? <Icon size={iconSize} /> : null}
      {children}
    </button>
  )
}

export function Spinner() {
  return <span className="spinner" />
}

export function Badge({
  kind,
  children,
}: {
  kind: 'ok' | 'warn' | 'danger' | 'accent' | 'muted'
  children: ReactNode
}) {
  return <span className={`badge badge-${kind}`}>{children}</span>
}

export function StatusBadge({ status }: { status: string }) {
  const kind =
    status === 'success' ? 'ok' : status === 'running' || status === 'queued' ? 'accent' : status === 'canceled' ? 'muted' : 'danger'
  return <Badge kind={kind}>{status}</Badge>
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon?: LucideIcon
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      {Icon && <Icon size={28} className="icon" strokeWidth={1.5} />}
      <div className="empty-title">{title}</div>
      {hint && <div>{hint}</div>}
      {action}
    </div>
  )
}

export function Field({
  label,
  error,
  children,
  hint,
}: {
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-error" style={{ color: 'var(--text-faint)' }}>{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}

export function TextInput({ mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input {...rest} className={`input${mono ? ' mono' : ''} ${rest.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`select ${props.className ?? ''}`} />
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="checkbox-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}
