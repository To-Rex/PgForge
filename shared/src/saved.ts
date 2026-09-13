/**
 * A named SQL snippet. History records what ran; this records what is worth
 * running again — so it is edited, named, and kept until deleted.
 */
export interface SavedQuery {
  id: string
  name: string
  description: string | null
  sql: string
  /** Null pins the snippet to no particular connection (available everywhere). */
  connectionId: string | null
  /** Visible to every user when true; otherwise only to its author. */
  shared: boolean
  ownerId: string
  ownerName: string
  createdAt: string
  updatedAt: string
}

export interface SavedQueryInput {
  name: string
  description?: string | null
  sql: string
  connectionId?: string | null
  shared?: boolean
}
