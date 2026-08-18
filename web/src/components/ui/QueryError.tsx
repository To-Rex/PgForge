import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../../lib/api.js'
import { Button } from './basics.js'

/** Inline failure state for data queries — never fail silently into blankness. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation()
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : t('errors.generic')
  return (
    <div className="sql-error" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span className="grow" style={{ whiteSpace: 'pre-wrap' }}>{message}</span>
      {onRetry && (
        <Button size="sm" icon={RefreshCw} onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}
