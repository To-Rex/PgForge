export interface ErdColumn {
  name: string
  type: string
  pk: boolean
  fk: boolean
  nullable: boolean
}

export interface ErdTable {
  schema: string
  name: string
  rowEstimate: number
  columns: ErdColumn[]
}

export interface ErdRelation {
  id: string
  fromSchema: string
  fromTable: string
  fromColumns: string[]
  toSchema: string
  toTable: string
  toColumns: string[]
}

export interface ErdGraph {
  tables: ErdTable[]
  relations: ErdRelation[]
}
