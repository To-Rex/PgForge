import { X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button, TextInput } from './basics.js'

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`modal${wide ? ' modal-lg' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = true,
  typeToConfirm,
  loading,
  onConfirm,
  onClose,
  children,
}: {
  title: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** When set, the user must type this exact string to enable the button. */
  typeToConfirm?: string
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const blocked = typeToConfirm !== undefined && typed !== typeToConfirm
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={blocked}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {message && <div>{message}</div>}
      {children}
      {typeToConfirm !== undefined && (
        <div className="field">
          <span className="field-label">{t('common.typeNameToConfirm', { name: typeToConfirm })}</span>
          <TextInput mono value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </div>
      )}
    </Modal>
  )
}

export interface MenuEntry {
  label: ReactNode
  icon?: ReactNode
  danger?: boolean
  onSelect: () => void
}

export function useMenu() {
  const [state, setState] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)

  const open = useCallback((e: ReactMouseEvent, entries: MenuEntry[]) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setState({ x: rect.left, y: rect.bottom + 4, entries })
  }, [])

  const close = useCallback(() => setState(null), [])

  const menu = state ? <MenuPopup state={state} onClose={close} /> : null
  return { open, close, menu }
}

function MenuPopup({
  state,
  onClose,
}: {
  state: { x: number; y: number; entries: MenuEntry[] }
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep the menu on-screen.
  const style = {
    left: Math.min(state.x, window.innerWidth - 200),
    top: Math.min(state.y, window.innerHeight - state.entries.length * 34 - 16),
  }

  return createPortal(
    <div ref={ref} className="menu" style={style} role="menu">
      {state.entries.map((entry, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`menu-item${entry.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose()
            entry.onSelect()
          }}
        >
          {entry.icon}
          {entry.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
