/** 列补全模式（单选 / 多选）的集成用例，走真实链路 collectCompletions → 候选 → apply */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import type { Completion } from '@codemirror/autocomplete'
import { collectCompletions, shouldConsumeSpaceForColumn, toggleColumnMark } from '@/utils/sql/sqlCompletion'
import type { ColumnCompletion } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime, MetadataProvider } from '@/utils/sql/sqlCompletion'
import { analyzeSqlCursorText } from '@/utils/sql/sqlCursor'

/** users(id, user_id, username, email, created_at) / orders(id, user_id, total_amount) */
const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: () => ['users', 'orders'],
  columns: (_connId, _database, table) => (table === 'orders'
    ? [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'user_id', dataType: 'int', comment: '' },
        { name: 'total_amount', dataType: 'decimal(10,2)', comment: '' },
      ]
    : [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'user_id', dataType: 'int', comment: '' },
        { name: 'username', dataType: 'varchar(64)', comment: '' },
        { name: 'email', dataType: 'varchar(128)', comment: '' },
        { name: 'created_at', dataType: 'datetime', comment: '' },
      ]),
}

/** 假编辑器：只实现列插入用到的 `state.doc` 读取与 `dispatch` */
function fakeView(doc: string) {
  let text = doc
  const changes: Array<{ from: number, to: number, insert: string }> = []
  const view = {
    state: {
      doc: {
        toString: () => text,
        sliceString: (from: number, to?: number) => text.slice(from, to),
      },
    },
    dispatch(spec: { changes?: { from: number, to: number, insert: string } }) {
      if (spec.changes) {
        changes.push(spec.changes)
        text = text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to)
      }
    },
  }
  return { view: view as unknown as Parameters<typeof toggleColumnMark>[0], changes, textOf: () => text }
}

/** 光标状态 + 补全 bundle + 光标意图（两者同源） */
function completionAt(docWithCursor: string) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const runtime: CompletionRuntime = {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata,
  }
  return {
    doc,
    bundle: collectCompletions(state, pos, runtime),
    intent: analyzeSqlCursorText(state, pos, 'mysql').column,
  }
}

/** 只取列候选 */
function fieldItems(bundle: ReturnType<typeof collectCompletions>): ColumnCompletion[] {
  return (bundle?.options ?? []).filter((item): item is ColumnCompletion => item.type === 'field')
}

describe('列补全模式：光标意图', () => {
  it('t.| 是多选：限定符 + 空前缀', () => {
    const { intent, bundle, doc } = completionAt('SELECT t.| FROM users t')
    expect(intent.mode).toBe('multi')
    expect(intent.isColumnList).toBe(true)
    expect(intent.qualifier).toBe('t')
    expect(intent.prefix).toBe('')
    expect(bundle?.from).toBe(9)
    expect(bundle?.to).toBe(9)
    expect(doc.slice(bundle!.from, bundle!.to)).toBe('')
  })

  it('t.user_id,| 是单选：逗号紧跟光标', () => {
    const { intent } = completionAt('SELECT t.user_id,| FROM users t')
    expect(intent.isColumnList).toBe(true)
    expect(intent.afterComma).toBe(true)
    expect(intent.commaFollowedBySpace).toBe(false)
    expect(intent.mode).toBe('single')
    expect(intent.previousItemKind).toBe('column')
    expect(intent.previousQualifier).toBe('t')
  })

  it('t.user_id, | 是多选：逗号后落了空白', () => {
    const { intent } = completionAt('SELECT t.user_id, | FROM users t')
    expect(intent.afterComma).toBe(true)
    expect(intent.commaFollowedBySpace).toBe(true)
    expect(intent.mode).toBe('multi')
  })

  it('已经在输入词就是单选（含点号限定符的输入）', () => {
    expect(completionAt('SELECT t.em| FROM users t').intent.mode).toBe('single')
    expect(completionAt('SELECT em| FROM users t').intent.mode).toBe('single')
  })

  it('列表刚开（新项还没写）是多选', () => {
    expect(completionAt('SELECT | FROM users t').intent.mode).toBe('multi')
  })
})

describe('列补全模式：候选标记', () => {
  it('多选场景的列候选都带 columnMode=multi，且插入文本带 t.', () => {
    const { bundle } = completionAt('SELECT t.| FROM users t')
    const fields = fieldItems(bundle)
    expect(fields.length).toBeGreaterThan(0)
    expect(fields.every(item => item.columnMode === 'multi')).toBe(true)
    expect(fields.every(item => (item.columnInsert ?? '').startsWith('t.'))).toBe(true)
  })

  it('单选场景的列候选没有 multi 标记（于是没有复选框）', () => {
    const { bundle } = completionAt('SELECT t.user_id,| FROM users t')
    expect(fieldItems(bundle).every(item => item.columnMode !== 'multi')).toBe(true)
  })

  it('逗号后空格的多选会沿用前一项的限定符（t.）', () => {
    const { bundle } = completionAt('SELECT t.user_id, | FROM users t')
    const fields = fieldItems(bundle)
    expect(fields.every(item => item.columnMode === 'multi')).toBe(true)
    expect(fields.every(item => (item.columnInsert ?? '').startsWith('t.'))).toBe(true)
  })

  it('限定符解析成功时不再混入表别名候选', () => {
    const { bundle } = completionAt('SELECT t.| FROM users t')
    expect((bundle?.options ?? []).every(item => item.type === 'field')).toBe(true)
  })

  it('多来源下的 `u.` 只给 u 的表列，不串到别的来源', () => {
    const { bundle } = completionAt('SELECT u.| FROM users u JOIN orders o ON o.user_id = u.id')
    const inserts = fieldItems(bundle).map(item => item.columnInsert)
    expect(inserts).toContain('u.username')
    expect(inserts.some(insert => insert?.startsWith('o.'))).toBe(false)
  })
})

describe('列补全模式：空格与多选插入', () => {
  it('空格只在多选列时被消费（单选必须真的插入空格）', () => {
    const multi = { type: 'field', label: 'id', columnMode: 'multi' } as ColumnCompletion
    const single = { type: 'field', label: 'id' } as ColumnCompletion
    expect(shouldConsumeSpaceForColumn('active', multi)).toBe(true)
    expect(shouldConsumeSpaceForColumn('active', single)).toBe(false)
    expect(shouldConsumeSpaceForColumn('inactive', multi)).toBe(false)
    expect(shouldConsumeSpaceForColumn('active', { type: 'keyword', label: 'SELECT' })).toBe(false)
  })

  it('单选候选不受残留勾选影响（同一弹层里从多选切到单选）', () => {
    const single = fieldItems(completionAt('SELECT t.user_id,| FROM users t').bundle)
    const picked = single.find(item => item.label === 'email')
    expect(picked).toBeTruthy()
    const { view, textOf } = fakeView('SELECT t.user_id,')
    // 先勾两个，再应用单选候选
    toggleColumnMark(view, 'users@t.id', 't.id')
    toggleColumnMark(view, 'users@t.username', 't.username')

    const apply = picked?.apply
    if (typeof apply === 'function') {
      apply(view as never, picked as Completion, 17, 17)
    }
    expect(textOf()).toBe('SELECT t.user_id,email')
  })

  it('勾选多列后回车：每一列都保留 t. 限定符', () => {
    const { bundle } = completionAt('SELECT t.| FROM users t')
    const fields = fieldItems(bundle)
    const pick = ['id', 'email', 'created_at']
    const { view, changes, textOf } = fakeView('SELECT t.')

    for (const name of pick) {
      const item = fields.find(entry => entry.label === name)
      expect(item).toBeTruthy()
      toggleColumnMark(view, item!.columnKey ?? name, item!.columnInsert ?? name)
    }

    // 应用任意一个候选，勾选项一次性插入
    const first = fields.find(entry => entry.label === 'id')
    const apply = first?.apply
    expect(typeof apply).toBe('function')
    if (typeof apply === 'function') {
      apply(view as never, first as Completion, 9, 9)
    }

    expect(changes[0]?.from).toBe(9)
    expect(textOf()).toBe('SELECT t.id, t.email, t.created_at')
  })
})

describe('列补全模式：边界（不能误入多选）', () => {
  it('函数参数里的逗号不是 SELECT 列表', () => {
    expect(completionAt('SELECT func(a,|) FROM users t').intent.mode).toBe('single')
    expect(completionAt('SELECT func(a, |) FROM users t').intent.mode).toBe('single')
  })

  it('INSERT 列清单与 UPDATE SET 都不复用 SELECT 的多选', () => {
    expect(completionAt('INSERT INTO users (id,|)').intent.mode).toBe('single')
    expect(completionAt('UPDATE users SET name = x,|').intent.mode).toBe('single')
  })

  it('字符串里不补全（也就谈不上多选）', () => {
    expect(completionAt("SELECT 'a, |'").bundle).toBeNull()
  })

  it('嵌套子查询后的新输出项：作用域仍是外层，模式仍是多选', () => {
    const sqlText = [
      'SELECT t.user_id,',
      '       (',
      '         SELECT o.id',
      '         FROM orders o',
      '         WHERE o.user_id = t.user_id',
      '       ),',
      '       |',
      'FROM users t',
    ].join('\n')
    const { intent, bundle } = completionAt(sqlText)
    expect(intent.isColumnList).toBe(true)
    expect(intent.mode).toBe('multi')
    // 外层来源只有 users t
    const labels = fieldItems(bundle).map(item => item.label)
    expect(labels).toContain('username')
    expect(labels).not.toContain('total_amount')
  })
})

describe('列补全模式：来源解析不了就不给候选（不猜）', () => {
  it('`SELECT t.|` 单独一句（FROM 还没写）拿不到列', () => {
    // 别名不在作用域、或列元数据还没拉到时不猜，给空
    const alone = completionAt('SELECT t.|')
    expect(fieldItems(alone.bundle)).toHaveLength(0)

    const withFrom = completionAt('SELECT t.| FROM users t')
    expect(fieldItems(withFrom.bundle).length).toBeGreaterThan(0)
  })
})

describe('列补全模式：历史问题不复发', () => {
  it('FROM or| 仍然给 orders（关键字不抢表名位）', () => {
    const { bundle } = completionAt('SELECT * FROM or|')
    expect((bundle?.options ?? []).some(item => item.label === 'orders')).toBe(true)
  })

  it('多表同名列：u.created_at 与 o.created_at 都在', () => {
    const { bundle } = completionAt(
      'SELECT |\nFROM users u\nJOIN orders o ON o.user_id = u.id',
    )
    const inserts = fieldItems(bundle).map(item => item.columnInsert)
    expect(inserts).toContain('u.id')
    expect(inserts).toContain('o.id')
  })

  it('相关子查询里能解析到外层的 u', () => {
    const { bundle } = completionAt(
      'SELECT *\nFROM users u\nWHERE EXISTS (\n  SELECT 1\n  FROM orders o\n  WHERE o.user_id = u.|\n)',
    )
    const fields = fieldItems(bundle)
    expect(fields.length).toBeGreaterThan(0)
    expect(fields.every(item => (item.columnInsert ?? '').startsWith('u.'))).toBe(true)
  })
})
