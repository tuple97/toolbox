/**
 * SQL 光标语义用例：位置类别矩阵、语句范围、子句局部性。
 *
 * 位置标记用 `§`（`|` 在 SQL 里也可能出现在内容中，`§` 不会撞车）。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { analyzeSqlCursorText } from '@/utils/sql/sqlCursor'

const MARK = '§'

/** 分析 `§` 处（标记字符会从文档里移除） */
function intentOf(docWithCursor: string) {
  const pos = docWithCursor.indexOf(MARK)
  const doc = docWithCursor.replace(MARK, '')
  return intentAt(doc, pos)
}

/** 分析指定文档的指定位置（方言默认 MySQL） */
function intentAt(doc: string, pos: number, dbType = 'mysql') {
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  return analyzeSqlCursorText(state, pos, dbType)
}

describe('位置类别矩阵', () => {
  it('表名位置：FROM / JOIN 之后还没写表', () => {
    expect(intentOf('SELECT * FROM §')).toMatchObject({ kind: 'table', command: 'select' })
    expect(intentOf('SELECT * FROM a JOIN §')).toMatchObject({ kind: 'table', command: 'select' })
  })

  it('表之后：给连接与子句关键字', () => {
    expect(intentOf('SELECT * FROM users §').kind).toBe('keyword')
  })

  it('表达式位置：SELECT 列表 / WHERE 之后的列', () => {
    expect(intentOf('SELECT § FROM users').kind).toBe('column')
    expect(intentOf('SELECT * FROM users WHERE §').kind).toBe('column')
  })

  it('别名位置：AS 之后什么都不给', () => {
    expect(intentOf('SELECT * FROM users AS §').kind).toBe('alias')
    // 别名写完回到「表之后」
    expect(intentOf('SELECT * FROM users AS u §').kind).toBe('keyword')
  })

  it('关联条件：ON 且语句里有 JOIN', () => {
    expect(intentOf('SELECT * FROM a JOIN b ON §').kind).toBe('join-on')
  })

  it('分组：GROUP BY 之后', () => {
    expect(intentOf('SELECT * FROM users GROUP BY §').kind).toBe('group-by')
  })

  it('INSERT 列清单内', () => {
    expect(intentOf('INSERT INTO users (§)').kind).toBe('insert')
  })

  it('语句开头', () => {
    expect(intentOf(`${MARK}`).kind).toBe('statement-start')
    expect(intentOf('SELECT 1;\n§').kind).toBe('statement-start')
  })

  it('子查询里的关键字不影响外层', () => {
    const intent = intentOf('SELECT * FROM (SELECT * FROM t) x WHERE §')
    expect(intent.kind).toBe('column')
    expect(intent.clause.keyword).toBe('where')
  })

  it('字符串 / 注释里的关键字不算子句', () => {
    const intent = intentOf("SELECT * FROM users WHERE name = 'from x' §")
    expect(intent.clause.keyword).toBe('where')
    expect(intent.kind).toBe('column')
  })
})

describe('语句范围与边界', () => {
  it('光标停在语句末尾的普通空白里仍算这条语句', () => {
    const doc = 'SELECT * FROM users WHERE id = 1\n'
    const intent = intentAt(doc, doc.length)
    expect(intent.statement?.from).toBe(0)
    expect(intent.statementBoundary).toBe('trailing-whitespace')
  })

  it('空行之后是新语句（没写分号也算）', () => {
    const doc = 'SELECT * FROM users WHERE id = 1\n\n'
    const intent = intentAt(doc, doc.length)
    expect(intent.statementBoundary).toBe('blank-line')
    expect(intent.kind).toBe('statement-start')
  })

  it('空行后写前缀：子句扫描直接跑在新语句上', () => {
    const intent = intentOf('SELECT * FROM users AS t1\n\nS§')
    expect(intent.statementBoundary).toBe('blank-line')
    expect(intent.clausePrefix).toBe('S')
    expect(intent.kind).toBe('statement-start')
  })

  it('语句内部的空行不是边界（逗号结尾只是排版）', () => {
    const intent = intentOf('SELECT a,\n\nb§ FROM users')
    expect(intent.statementBoundary).toBe('inside-statement')
    expect(intent.kind).toBe('column')
  })

  it('括号里的空行不是边界', () => {
    const intent = intentOf('SELECT * FROM users WHERE id IN (\n\n1§)')
    expect(intent.statementBoundary).toBe('inside-statement')
  })

  it('空行后是续写（AND）也不算边界', () => {
    const intent = intentOf("SELECT * FROM users WHERE id = 1\n\nAND name = 'a'§")
    expect(intent.statementBoundary).toBe('inside-statement')
  })

  it('光标刚落到空行之后也进入新语句', () => {
    const intent = intentOf('SELECT * FROM users\n\n§')
    expect(intent.statementBoundary).toBe('blank-line')
    expect(intent.kind).toBe('statement-start')
  })

  it('结尾是 `*` 不影响空行边界（它是完整表达式，不是续写符）', () => {
    const intent = intentOf('SELECT *\n\nS§')
    expect(intent.statementBoundary).toBe('blank-line')
  })

  it('SELECT * 结束后的空行同样能开始下一条 SQL', () => {
    const intent = intentOf('SELECT *\nFROM users\n\nS§')
    expect(intent.statementBoundary).toBe('blank-line')
    expect(intent.kind).toBe('statement-start')
  })

  it('空行后的注释不能遮蔽续写 AND', () => {
    const intent = intentOf("SELECT * FROM users WHERE id = 1\n\n-- continue condition\nAND name = 'a'§")
    expect(intent.statementBoundary).toBe('inside-statement')
  })

  it('MySQL `#` 注释之后同样识别新语句', () => {
    const intent = intentOf('SELECT * FROM users\n\n# next\nS§')
    expect(intent.statementBoundary).toBe('blank-line')
  })

  it('PostgreSQL dollar quote 内部的空行不是边界', () => {
    const sql = 'DO $$\n\nBEGIN\n  RAISE NOTICE \'x\';\nEND\n\n$$;'
    const intent = intentAt(sql, sql.indexOf('BEGIN'), 'postgres')
    expect(intent.statementBoundary).toBe('inside-statement')
  })

  it('多语句：只认光标所在的那一条', () => {
    const doc = 'SELECT 1;\nSELECT * FROM users'
    const intent = intentAt(doc, doc.length)
    expect(intent.statement?.from).toBe(doc.indexOf('SELECT * FROM users'))
    // 子句前缀也只从这条语句开始，不会把上一条的 SELECT 当上下文
    expect(intent.clausePrefix.startsWith('SELECT * FROM users')).toBe(true)
  })
})

describe('主关键字', () => {
  it('取语句第一个词', () => {
    expect(intentOf('update users set §').command).toBe('update')
    expect(intentOf('WITH c AS (SELECT 1) SELECT § FROM c').command).toBe('with')
  })

  it('跳过前导注释', () => {
    expect(intentOf('-- 说明\nSELECT § FROM users').command).toBe('select')
    expect(intentOf('/* 块注释 */ SELECT § FROM users').command).toBe('select')
  })
})
