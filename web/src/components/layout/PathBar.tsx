import type { ReactNode } from 'react'

export interface PathSegment {
  kind: 'conn' | 'db' | 'schema' | 'object'
  label: string
  onClick?: () => void
}

/**
 * The signature element: current location rendered as a qualified identifier —
 * connection.database.schema.object — each segment syntax-colored like SQL.
 */
export function PathBar({
  segments,
  actions,
}: {
  segments: PathSegment[]
  actions?: ReactNode
}) {
  return (
    <div className="pathbar">
      <div className="path" aria-label="breadcrumb">
        {segments.map((seg, i) => (
          <span key={i} className={`path-seg ${seg.kind}`}>
            {i > 0 && <span className="path-dot">.</span>}
            {seg.onClick ? (
              <button type="button" onClick={seg.onClick}>
                {seg.label}
              </button>
            ) : (
              <span>{seg.label}</span>
            )}
          </span>
        ))}
      </div>
      {actions && <div className="pathbar-actions">{actions}</div>}
    </div>
  )
}
