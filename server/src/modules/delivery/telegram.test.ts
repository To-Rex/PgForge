import { describe, expect, it } from 'vitest'
import { extractTelegramChatIds } from './telegram.js'

describe('extractTelegramChatIds', () => {
  it('collects unique chat ids across update kinds', () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 100 }, text: '/start' } },
      { update_id: 2, message: { chat: { id: 100 }, text: 'hi' } },
      { update_id: 3, edited_message: { chat: { id: 200 } } },
      { update_id: 4, channel_post: { chat: { id: -100123 } } },
      { update_id: 5, my_chat_member: { chat: { id: 300 } } },
      { update_id: 6, callback_query: { message: { chat: { id: 400 } } } },
    ]
    expect(extractTelegramChatIds(updates).sort()).toEqual(['-100123', '100', '200', '300', '400'].sort())
  })

  it('returns empty for non-array or empty payloads', () => {
    expect(extractTelegramChatIds(undefined)).toEqual([])
    expect(extractTelegramChatIds([])).toEqual([])
    expect(extractTelegramChatIds([{ update_id: 1 }])).toEqual([])
  })
})
