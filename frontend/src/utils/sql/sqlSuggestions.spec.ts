/**
 * 候选生成层用例：确认它是「吃语义对象 + 依赖」的纯函数层。
 *
 * 位置标记用 `§`。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { analyzeSqlCursorText } from '@/utils/sql/sqlCursor'
import type { MetadataProvider } from '@/utils/sql/sqlCompletion'
import type { TableRef } from '@/utils/sql/sqlSchema'
import {
  DEFAULT_SUGGESTION_PROVIDERS,
  columnsOfRef,
  generalSuggestions,
  joinConditionSuggestions,
  resolveAfterDot,
  runSuggestionProviders,
  staticOptions,
  suggestionContextOf,
} from '@/utils/sql/sqlSuggestions'
import type {
  SqlSuggestDeps,
  SuggestionContext,
  SuggestionProvider,
} from '@/utils/sql/sqlSuggestions'

const MARK = '§'

/** 静态元数据：testdb 下 users(id, name)、orders(id, user_id) */
const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: (_connId, database) => (database === 'testdb' ? ['users', 'orders'] : []),
  columns: (_connId, _database, table) => {
    if (table === 'users') {
      return [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'name', dataType: 'varchar', comment: '名称' },
      ]
    }
    if (table === 'orders') {
      return [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'user_id', dataType: 'int', comment: '用户' },
      ]
    }
    return []
  },
  foreignKeys: (_connId, _database, table) => (table === 'orders'
    ? [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }]
    : []),
}

const deps: SqlSuggestDeps = { connId: 1, database: 'testdb', dialect: 'mysql', metadata }

/** 光标语义（用真实的分析器构造） */
function intentOf(docWithCursor: string) {
  const pos = docWithCursor.indexOf(MARK)
  const doc = docWithCursor.replace(MARK, '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  return analyzeSqlCursorText(state, pos, 'mysql')
}

/** users u 的作用域 */
const usersScope: TableRef[][] = [[{ schema: '', table: 'users', alias: 'u' }]]

describe('staticOptions', () => {
  it('给关键字与函数', () => {
    const labels = staticOptions().map(item => item.label)
    expect(labels).toContain('SELECT')
    expect(labels).toContain('COUNT')
  })

  it('可以关掉函数候选（轻量场景）', () => {
    const labels = staticOptions({ disableFunctions: true }).map(item => item.label)
    expect(labels).toContain('SELECT')
    expect(labels).not.toContain('COUNT')
  })
})

describe('generalSuggestions', () => {
  it('表达式位置：给出列与别名', () => {
    const items = generalSuggestions({
      intent: intentOf('SELECT § FROM users u'),
      scopes: usersScope,
      deps,
    })
    const labels = items.map(item => item.label)
    expect(labels).toContain('name')
    expect(labels).toContain('u')
  })

  it('别名位置什么都不给', () => {
    const items = generalSuggestions({
      intent: intentOf('SELECT * FROM users AS §'),
      scopes: usersScope,
      deps,
    })
    expect(items).toEqual([])
  })

  it('表名位置只给表与库（不给列）', () => {
    const labels = generalSuggestions({
      intent: intentOf('SELECT * FROM §'),
      scopes: [],
      deps,
    }).map(item => item.label)
    expect(labels).toContain('users')
    expect(labels).toContain('testdb')
    expect(labels).not.toContain('name')
  })

  it('跳过的列不再重复出现（GROUP BY 推荐去重）', () => {
    const labels = generalSuggestions({
      intent: intentOf('SELECT * FROM users u GROUP BY §'),
      scopes: usersScope,
      deps,
      skipColumns: new Set(['name']),
    }).map(item => item.label)
    expect(labels).not.toContain('name')
    expect(labels).toContain('id')
  })
})

describe('resolveAfterDot', () => {
  it('别名命中该表的字段', () => {
    const labels = resolveAfterDot(['u'], usersScope, deps).map(item => item.label)
    expect(labels).toContain('name')
  })

  it('库里已知的表名给该表字段', () => {
    const labels = resolveAfterDot(['users'], [], deps).map(item => item.label)
    expect(labels).toContain('name')
  })
})

describe('columnsOfRef', () => {
  it('派生表用静态解析出的列，不查元数据', () => {
    const ref: TableRef = {
      schema: '',
      table: 't1',
      alias: 't1',
      virtualColumns: [{ name: 'x', from: 'users', dataType: 'int' }],
    }
    expect(columnsOfRef(ref, deps).map(column => column.name)).toEqual(['x'])
  })

  it('物理表查元数据', () => {
    const ref: TableRef = { schema: '', table: 'users', alias: 'u' }
    expect(columnsOfRef(ref, deps).map(column => column.name)).toEqual(['id', 'name'])
  })
})

describe('候选族注册表', () => {
  /** 手搭上下文：只测「哪个族在什么位置出现」，不掺进分析器与元数据 */
  function ctxOf(overrides: Partial<SuggestionContext>): SuggestionContext {
    return {
      ...suggestionContextOf({
        intent: intentOf('SELECT § FROM users u'),
        scopes: usersScope,
        deps,
      }),
      ...overrides,
    }
  }

  /** 该上下文下会出候选的族（顺序 = 注册顺序 = 候选出现顺序） */
  function providersAt(ctx: SuggestionContext): string[] {
    return DEFAULT_SUGGESTION_PROVIDERS
      .filter(provider => provider.supports(ctx))
      .map(provider => provider.id)
  }

  it('别名位置没有任何族（`AS` 之后只能写别名）', () => {
    expect(providersAt(ctxOf({ kind: 'alias' }))).toEqual([])
  })

  it('表名位置只有表与库 —— 关键字不许冒出来干扰', () => {
    expect(providersAt(ctxOf({ kind: 'source', tight: 'none' }))).toEqual(['tables', 'namespaces'])
    // 正在写那个关键字本身（`FROM|`）：表与库都不给
    expect(providersAt(ctxOf({ kind: 'source', tight: 'keyword' }))).toEqual([])
  })

  it('表达式位置：列 → 关键字 → 函数（表与库让位）', () => {
    expect(providersAt(ctxOf({ kind: 'column' }))).toEqual(['columns', 'keywords', 'functions'])
  })

  it('表写完之后：表 + 库 + 关键字，但没有列', () => {
    expect(providersAt(ctxOf({ kind: 'afterSource', tight: 'none' })))
      .toEqual(['tables', 'namespaces', 'keywords'])
  })

  it('紧贴正在输入的标识符时，表与库一起给（两者时机相同）', () => {
    /*
     * `FROM ord|`：表名（orders）与库名（order_center）都是用户可能要写的 ——
     * 选定库名后接着敲 `.` 就能展开它的表。所以表与库共用同一条资格判据，
     * 不再拿 tight 当「库名要不要让位」的代理。
     */
    expect(providersAt(ctxOf({ kind: 'source', tight: 'name' })))
      .toEqual(['tables', 'namespaces'])
  })

  it('函数候选可由 featureFlags 关掉（轻量场景）', () => {
    expect(providersAt(ctxOf({ kind: 'column', flags: { disableFunctions: true } })))
      .toEqual(['columns', 'keywords'])
  })

  it('supports 只看位置，不看数据 —— 元数据为空时结论不变', () => {
    const emptyDeps: SqlSuggestDeps = {
      ...deps,
      metadata: { databases: () => [], tables: () => [], columns: () => [] },
    }
    const ctx = { ...ctxOf({ kind: 'source', tight: 'none' }), deps: emptyDeps }
    expect(providersAt(ctx)).toEqual(['tables', 'namespaces'])
    // 族照样被问到，只是给不出东西（「位置判断」与「数据可用性」不纠缠）
    expect(runSuggestionProviders(ctx)).toEqual([])
  })

  it('注册表可替换：插入自定义族就出现在指定位置', () => {
    const custom: SuggestionProvider = {
      id: 'custom',
      supports: () => true,
      provide: () => [{ label: '我的候选' }],
    }
    const ctx = ctxOf({ kind: 'source', tight: 'none' })
    expect(runSuggestionProviders(ctx, [custom]).map(item => item.label))
      .toEqual(['我的候选'])
    // 排在最前时它就在结果最前（顺序由注册表决定）
    expect(runSuggestionProviders(ctx, [custom, ...DEFAULT_SUGGESTION_PROVIDERS])[0]?.label)
      .toBe('我的候选')
    // 空注册表 = 什么都不给（不像「关不掉」的隐式行为）
    expect(runSuggestionProviders(ctx, [])).toEqual([])
  })
})

describe('joinConditionSuggestions', () => {
  it('两表之间给关联条件（外键优先）', () => {
    const scopes: TableRef[][] = [[
      { schema: '', table: 'users', alias: 'u' },
      { schema: '', table: 'orders', alias: 'o' },
    ]]
    const items = joinConditionSuggestions(scopes, deps)
    expect(items.length).toBeGreaterThan(0)
    expect(items.some(item => String(item.apply).includes('user_id'))).toBe(true)
  })

  it('只有一张表时不给（没得关联）', () => {
    expect(joinConditionSuggestions(usersScope, deps)).toEqual([])
  })
})
