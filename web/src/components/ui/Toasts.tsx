import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useToastStore } from '../../stores/toast.js'

const ICONS = {
  ok: <CheckCircle2 size={15} style={{ color: 'var(--ok)', flexShrink: 0, marginTop: 1 }} />,
  error: <AlertCircle size={15} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />,
  info: <Info size={15} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />,
}

export function Toasts() {
  const { toasts, dismiss } = useToastStore()
  if (toasts.length === 0) return null
  return (
    <div className="toast-region" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          {ICONS[toast.kind]}
          <span className="grow" style={{ wordBreak: 'break-word' }}>
            {toast.message}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
