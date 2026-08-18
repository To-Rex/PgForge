/**
 * Collects unique chat ids from a Telegram getUpdates payload — used for
 * broadcast mode when no explicit Chat ID is configured.
 */
export function extractTelegramChatIds(updates: unknown): string[] {
  const ids = new Set<string>()
  if (!Array.isArray(updates)) return []
  for (const update of updates as Array<Record<string, unknown>>) {
    const containers = [
      update.message,
      update.edited_message,
      update.channel_post,
      update.my_chat_member,
      (update.callback_query as Record<string, unknown> | undefined)?.message,
    ]
    for (const container of containers) {
      const chat = (container as { chat?: { id?: unknown } } | undefined)?.chat
      const id = chat?.id
      if (typeof id === 'number' || typeof id === 'string') ids.add(String(id))
    }
  }
  return [...ids]
}
