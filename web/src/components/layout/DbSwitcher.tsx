import { useTranslation } from 'react-i18next'
import { Select } from '../ui/basics.js'
import { useDatabases } from '../../lib/queries.js'

export function DbSwitcher({
  connId,
  db,
  onChange,
}: {
  connId: string
  db: string
  onChange: (db: string) => void
}) {
  const { t } = useTranslation()
  const databases = useDatabases(connId)
  const names = databases.data?.map((d) => d.name) ?? []
  const options = names.includes(db) ? names : [db, ...names]
  return (
    <Select
      value={db}
      onChange={(e) => onChange(e.target.value)}
      aria-label={t('db.switchDatabase')}
      className="mono"
      style={{ width: 'auto', minWidth: 120, height: 26, fontSize: 'var(--text-xs)' }}
    >
      {options.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </Select>
  )
}
