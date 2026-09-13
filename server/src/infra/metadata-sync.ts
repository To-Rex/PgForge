import type { MetadataSnapshotInfo } from '@pgforge/shared'
import type { PostgresMetadataBackend } from './metadata-pg.js'
import type { MetaStore } from './store.js'

/** Writes are coalesced: a burst of statements produces one upload. */
const DEBOUNCE_MS = 1_000
/** Safety net for a write path that somehow never signalled a change. */
const HEARTBEAT_MS = 60_000

/**
 * Keeps the durable copy of the metadata store in step with the local one.
 *
 * Replication is asynchronous because the store is synchronous: a statement
 * returns as soon as SQLite has it, and the upload follows within a second.
 * That leaves a small window in which a hard crash loses the most recent
 * writes — the trade for leaving every repository and the connection resolver
 * exactly as they are.
 */
export class MetadataSync {
  private timer: NodeJS.Timeout | null = null
  private readonly heartbeat: NodeJS.Timeout
  private flushing: Promise<void> | null = null
  private dirty = false
  private stopped = false
  private lastSyncedAt: string | null = null
  private lastError: string | null = null
  private snapshotInfo: MetadataSnapshotInfo | null = null

  constructor(
    private readonly store: MetaStore,
    private readonly backend: PostgresMetadataBackend,
    private readonly appVersion: string,
    private readonly log: (level: 'warn' | 'info', message: string) => void,
  ) {
    this.heartbeat = setInterval(() => {
      if (this.dirty) void this.flush()
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  get status(): {
    lastSyncedAt: string | null
    lastError: string | null
    snapshot: MetadataSnapshotInfo | null
  } {
    return {
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      snapshot: this.snapshotInfo,
    }
  }

  /** Called after every write to the store. Cheap and safe to call often. */
  markDirty(): void {
    if (this.stopped) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, DEBOUNCE_MS)
    this.timer.unref()
  }

  /**
   * Uploads now, waiting for any in-flight upload first. `force` uploads even
   * when nothing changed — what the operator means by "sync now".
   */
  async flush(force = false): Promise<void> {
    // Serialize: overlapping uploads could land out of order.
    if (this.flushing) {
      await this.flushing
      if (!this.dirty && !force) return
    }
    if (!this.dirty && !force && this.lastSyncedAt !== null) return

    this.dirty = false
    this.flushing = (async () => {
      try {
        const bytes = this.store.snapshot()
        this.snapshotInfo = await this.backend.save(bytes, this.appVersion)
        this.lastSyncedAt = new Date().toISOString()
        this.lastError = null
      } catch (err) {
        // Keep the change pending so the next tick retries it.
        this.dirty = true
        this.lastError = err instanceof Error ? err.message : String(err)
        this.log('warn', `Metadata replication failed: ${this.lastError}`)
      } finally {
        this.flushing = null
      }
    })()
    await this.flushing
  }

  /** Final flush, then no further uploads. Safe to call twice. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.heartbeat)
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // stopped blocks markDirty, not this last write.
    this.dirty = true
    this.stopped = false
    await this.flush()
    this.stopped = true
  }
}
