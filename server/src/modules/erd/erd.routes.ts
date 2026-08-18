import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parse } from '../../core/validate.js'
import type { ErdService } from './erd.service.js'

const querySchema = z.object({ schema: z.string().min(1).max(63).default('public') })

export function registerErdRoutes(app: FastifyInstance, erd: ErdService): void {
  app.get('/api/connections/:connId/db/:db/erd', async (req) => {
    const { connId, db } = req.params as { connId: string; db: string }
    const { schema } = parse(querySchema, req.query)
    return erd.graph(connId, db, schema)
  })
}
