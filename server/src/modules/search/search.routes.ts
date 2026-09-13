import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parse } from '../../core/validate.js'
import { SEARCH_MAX_HITS, type SearchService } from './search.service.js'

const searchQuerySchema = z.object({
  q: z.string().min(1).max(120),
  scope: z.enum(['database', 'server']).default('database'),
  db: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_HITS).default(40),
})

export function registerSearchRoutes(app: FastifyInstance, search: SearchService): void {
  app.get('/api/connections/:connId/search', async (req) => {
    const { connId } = req.params as { connId: string }
    const query = parse(searchQuerySchema, req.query)
    return search.search(connId, query)
  })
}
