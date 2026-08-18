import type { ReactNode } from 'react'

export interface TabDef<K extends string> {
  key: K
  label: ReactNode
}

export function Tabs<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef<K>[]
  active: K
  onChange: (key: K) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          className="tab"
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
