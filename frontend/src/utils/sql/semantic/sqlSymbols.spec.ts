/**
 * 语义符号用例：位置 → 表别名符号 → 引用集合。
 *
 * 这是 Rename / Hover 共用的地基，重点验证文档里的边界：
 * 作用域遮蔽、相关子查询、列别名不是表别名、字符串与注释不算引用。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import {
  getColumnAliasReferences,
  getCteReferences,
  getTableAliasReferences,
  resolveColumnAliasAtPosition,
  resolveCteAtPosition,
  resolveTableAliasAtPosition,
  resolveTableAtPosition,
  scopesAt,
  symbolOccurrencesAt,
} from '@/utils/sql/semantic/sqlSymbols'

/** 用 `|` 标出光标位置，建一个编辑器状态 */
function stateOf(docWithCursor: string) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  return { state: EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] }), pos, doc }
}

/** 位置处的别名符号名（没有则 null） */
function aliasNameAt(docWithCursor: string) {
  const { state, pos } = stateOf(docWithCursor)
  return resolveTableAliasAtPosition(state, pos, 'mysql')?.name ?? null
}

/** 位置处的表名（经别名解析） */
function tableNameAt(docWithCursor: string) {
  const { state, pos } = stateOf(docWithCursor)
  return resolveTableAtPosition(state, pos, 'mysql')?.tableName ?? null
}

/** 别名符号的引用文本列表 */
function referenceTextsOf(docWithCursor: string, symbolName: string) {
  const { state, pos, doc } = stateOf(docWithCursor)
  const symbol = resolveTableAliasAtPosition(state, pos, 'mysql')
  expect(symbol?.name).toBe(symbolName)
  if (!symbol) {
    return []
  }
  return getTableAliasReferences(state, symbol, 'mysql')
    .map(range => doc.slice(range.from, range.to))
}

describe('语义符号：边界用真实语句（不吃补全的空行边界）', () => {
  it('空行后写前缀时，语义仍归属真实语句', () => {
    /*
     * 补全会把 `\n\nS` 当成新语句（编辑器意图）；语义层不行 ——
     * `statementAtCursor` 认为 `… users u\n\nS` 还是同一条语句，
     * 所以别名 u 仍然可见。这条是用例区分两个口径的关键。
     */
    const { state, pos } = stateOf('SELECT * FROM users u\n\nS|')
    const aliases = scopesAt(state, pos, 'mysql')
      .flatMap(scope => scope.refs)
      .map(ref => ref.alias)
    expect(aliases).toContain('u')
  })

  it('分号分隔的第二条 SQL 有自己的作用域', () => {
    const { state, pos } = stateOf('SELECT * FROM users u;\n\nSELECT * FROM orders o WHERE o.|')
    const aliases = scopesAt(state, pos, 'mysql')
      .flatMap(scope => scope.refs)
      .map(ref => ref.alias)
    expect(aliases).toContain('o')
    // 上一条 SQL 的 u 不泄漏
    expect(aliases).not.toContain('u')
  })
})

describe('语义符号：作用域与来源', () => {
  it('每个作用域都能拿到自己的表引用与位置', () => {
    const { state, pos } = stateOf('SELECT u.id FROM users u WHERE u.id = 1|')
    const scopes = scopesAt(state, pos, 'mysql')
    expect(scopes).toHaveLength(1)
    const ref = scopes[0].refs.find(item => item.alias === 'u')
    expect(ref?.table).toBe('users')
    // 别名声明的范围指向文本里的那个 u
    expect(ref?.aliasRange).toBeTruthy()
    const doc = state.doc.toString()
    expect(doc.slice(ref!.aliasRange!.from, ref!.aliasRange!.to)).toBe('u')
  })

  it('内层子查询是独立作用域（链上有两层）', () => {
    const { state, pos } = stateOf('SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = u.id|)')
    const scopes = scopesAt(state, pos, 'mysql')
    expect(scopes.length).toBeGreaterThan(1)
    // 最内层是 orders o，外层是 users u
    expect(scopes[0].refs.some(ref => ref.alias === 'o')).toBe(true)
    expect(scopes[scopes.length - 1].refs.some(ref => ref.alias === 'u')).toBe(true)
  })
})

describe('语义符号：别名解析', () => {
  it('别名声明处可解析', () => {
    expect(aliasNameAt('SELECT u.id FROM users |u WHERE u.id = 1')).toBe('u')
    expect(aliasNameAt('SELECT u.id FROM users u WHERE |u.id = 1')).toBe('u')
    // 语句末尾的字面量不是别名
    expect(aliasNameAt('SELECT u.id FROM users u WHERE u.id = 1|')).toBeNull()
  })

  it('限定符引用处解析回同一个声明', () => {
    expect(aliasNameAt('SELECT |u.id FROM users u')).toBe('u')
    expect(aliasNameAt('SELECT u.id FROM users u WHERE |u.id = 1')).toBe('u')
  })

  it('表名本身解析为物理表；别名解析到同一张表', () => {
    expect(tableNameAt('SELECT * FROM |users')).toBe('users')
    expect(tableNameAt('SELECT * FROM users |u')).toBe('users')
    expect(tableNameAt('SELECT |u.id FROM users u')).toBe('users')
  })

  it('列别名不是表别名', () => {
    // `AS u` 后面没有点号，也没有 FROM 里的别名声明
    expect(aliasNameAt('SELECT username AS |u FROM orders')).toBeNull()
  })

  it('字符串与注释里不解析', () => {
    expect(aliasNameAt("SELECT u.id FROM users u WHERE name = '|u'")).toBeNull()
    expect(aliasNameAt('SELECT u.id FROM users u -- |u')).toBeNull()
  })

  it('拿不到来源时（表名后面还没分别名）不把它当别名', () => {
    expect(aliasNameAt('SELECT * FROM |users')).toBeNull()
  })
})

describe('语义符号：引用集合（重命名范围）', () => {
  it('声明之外的限定符引用全部收进来', () => {
    expect(referenceTextsOf(
      'SELECT |u.id, u.email FROM users u WHERE u.id = 1 ORDER BY u.created_at',
      'u',
    )).toEqual(['u', 'u', 'u', 'u'])
  })

  it('字符串里的同名文本不算引用', () => {
    expect(referenceTextsOf(
      "SELECT u.id FROM users |u WHERE message = 'u'",
      'u',
    )).toEqual(['u'])
  })

  it('注释里的同名文本不算引用', () => {
    expect(referenceTextsOf(
      'SELECT u.id FROM users |u -- u should not change',
      'u',
    )).toEqual(['u'])
  })

  it('同名别名的两层作用域互不干扰', () => {
    const doc = 'SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders u WHERE u.id = 1)'
    // 外层 u：只有 SELECT 里那处；内层的 u 是另一个符号，不能碰
    expect(referenceTextsOf(doc.replace('u.id FROM', '|u.id FROM'), 'u')).toEqual(['u'])
    // 内层 u：只有内层 WHERE 里那处（光标放在内层限定符上）
    expect(referenceTextsOf(doc.replace('WHERE u.id', 'WHERE |u.id'), 'u')).toEqual(['u'])
    // 内层别名声明处解析到的也是内层符号（而不是外层的同名别名）
    const innerDecl = stateOf(doc.replace('orders u', 'orders |u'))
    expect(resolveTableAliasAtPosition(innerDecl.state, innerDecl.pos, 'mysql')?.tableName)
      .toBe('orders')
  })

  it('相关子查询里的外层引用会被收进来', () => {
    expect(referenceTextsOf(
      'SELECT u.id FROM users |u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
      'u',
    )).toEqual(['u', 'u'])
  })

  it('别的语句里的同名别名不算', () => {
    expect(referenceTextsOf(
      'SELECT u.id FROM users u; SELECT u.name FROM orders u|',
      'u',
    )).toEqual(['u'])
  })

  it('派生表别名同样可解析可重命名（P2：派生表不是死角）', () => {
    expect(aliasNameAt('SELECT |t.id FROM (SELECT id FROM users) t')).toBe('t')
    expect(aliasNameAt('SELECT t.id FROM (SELECT id FROM users) |t')).toBe('t')
    expect(referenceTextsOf('SELECT t.id, t.id FROM (SELECT id FROM users) |t', 't'))
      .toEqual(['t', 't'])
  })
})

describe('语义符号：中文标识符（词法认 CJK）', () => {
  it('中文表别名可解析、可重命名', () => {
    expect(aliasNameAt('SELECT |用户.id FROM users 用户')).toBe('用户')
    expect(aliasNameAt('SELECT 用户.id FROM users |用户')).toBe('用户')
    expect(referenceTextsOf(
      'SELECT 用户.id, 用户.email FROM users |用户 WHERE 用户.id = 1',
      '用户',
    )).toEqual(['用户', '用户', '用户'])
  })

  it('不做子串匹配：`a用户` 不是别名 `用户` 的引用', () => {
    expect(aliasNameAt('SELECT a用户.id FROM users |用户')).toBe('用户')
    expect(referenceTextsOf('SELECT a用户.id FROM users |用户', '用户')).toEqual([])
  })

  it('中文 CTE 名可解析、可重命名', () => {
    expect(cteNameAt('WITH |最近 AS (SELECT 1) SELECT * FROM 最近')).toBe('最近')
    expect(cteReferenceTextsOf(
      'WITH |最近 AS (SELECT 1) SELECT 最近.id FROM 最近',
    )).toEqual(['最近', '最近'])
  })

  it('中文派生列能通过别名解析出来（结构层同样认得中文）', () => {
    const { state, pos } = stateOf('SELECT t.名字 FROM (SELECT 名称 AS 名字 FROM users) |t')
    const refs = scopesAt(state, pos, 'mysql')[0]?.refs ?? []
    const derived = refs.find(ref => ref.alias === 't')
    expect(derived?.virtualColumns?.map(column => column.name)).toEqual(['名字'])
  })
})

/** 位置处的列别名（没有则 null） */
function columnAliasNameAt(docWithCursor: string) {
  const { state, pos } = stateOf(docWithCursor)
  return resolveColumnAliasAtPosition(state, pos, 'mysql')?.name ?? null
}

/** 列别名的引用文本列表 */
function columnAliasReferenceTextsOf(docWithCursor: string) {
  const { state, pos, doc } = stateOf(docWithCursor)
  const symbol = resolveColumnAliasAtPosition(state, pos, 'mysql')
  if (!symbol) {
    return []
  }
  return getColumnAliasReferences(state, symbol, 'mysql').map(range => doc.slice(range.from, range.to))
}

describe('语义符号：列别名', () => {
  it('声明处与 ORDER BY / GROUP BY 的裸引用都能解析', () => {
    expect(columnAliasNameAt('SELECT u.name AS |姓名 FROM users u ORDER BY 姓名')).toBe('姓名')
    expect(columnAliasNameAt('SELECT u.name AS 姓名 FROM users u ORDER BY |姓名')).toBe('姓名')
    expect(columnAliasNameAt('SELECT u.name AS n FROM users u GROUP BY |n')).toBe('n')
    // 隐式别名同样认
    expect(columnAliasNameAt('SELECT u.name n FROM users u ORDER BY |n')).toBe('n')
  })

  it('裸列名不是别名（绝不会把列名当别名改掉）', () => {
    expect(columnAliasNameAt('SELECT |name FROM users')).toBeNull()
    expect(columnAliasNameAt('SELECT u.|name FROM users u')).toBeNull()
    expect(columnAliasNameAt('SELECT * FROM |users')).toBeNull()
  })

  it('WHERE / HAVING 里的同名标识符不是这个别名的引用', () => {
    expect(columnAliasNameAt('SELECT u.name AS n FROM users u WHERE |n = 1')).toBeNull()
    // HAVING 在 PostgreSQL 里根本不允许输出别名，一律不认
    expect(columnAliasNameAt('SELECT u.name AS n FROM users u GROUP BY n HAVING |n > 1')).toBeNull()
    expect(columnAliasReferenceTextsOf(
      'SELECT u.name AS n FROM users u WHERE n = 1 GROUP BY n ORDER BY |n',
    )).toEqual(['n', 'n'])
  })

  it('带限定符的引用属于表，不属于列别名', () => {
    // 别名 x 与同名裸引用都存在，但 `a.x` 明确属于表 a
    expect(columnAliasNameAt('SELECT a.b AS x FROM t a ORDER BY a.|x')).toBeNull()
  })

  it('`CASE … END` 的 END 不会被当成隐式别名', () => {
    expect(columnAliasNameAt('SELECT CASE WHEN u.id THEN 1 |END FROM users u')).toBeNull()
  })

  it('symbolOccurrencesAt 给出声明与全部引用（引用高亮用）', () => {
    const { state, pos, doc } = stateOf('SELECT u.id FROM users |u WHERE u.id = 1')
    const occurrences = symbolOccurrencesAt(state, pos, 'mysql')
    expect(occurrences?.kind).toBe('table-alias')
    if (!occurrences) {
      throw new Error('应当解析出符号')
    }
    expect(doc.slice(occurrences.declaration.from, occurrences.declaration.to)).toBe('u')
    expect(occurrences.references.map(range => doc.slice(range.from, range.to))).toEqual(['u', 'u'])
  })

  it('物理表名没有出现位置可点亮', () => {
    const { state, pos } = stateOf('SELECT * FROM |users')
    expect(symbolOccurrencesAt(state, pos, 'mysql')).toBeNull()
  })

  it('字符串与注释里不解析，也不会被算成引用', () => {
    expect(columnAliasNameAt("SELECT u.name AS n FROM users u ORDER BY '|n'")).toBeNull()
    expect(columnAliasNameAt('SELECT u.name AS n FROM users u ORDER BY |n -- n')).toBe('n')
    expect(columnAliasReferenceTextsOf(
      'SELECT u.name AS n FROM users u ORDER BY |n -- n',
    )).toEqual(['n'])
  })
})

/** 位置处的 CTE 名（没有则 null） */
function cteNameAt(docWithCursor: string) {
  const { state, pos } = stateOf(docWithCursor)
  return resolveCteAtPosition(state, pos, 'mysql')?.name ?? null
}

/** CTE 名字的引用文本列表 */
function cteReferenceTextsOf(docWithCursor: string) {
  const { state, pos, doc } = stateOf(docWithCursor)
  const symbol = resolveCteAtPosition(state, pos, 'mysql')
  if (!symbol) {
    return []
  }
  return getCteReferences(state, symbol, 'mysql').map(range => doc.slice(range.from, range.to))
}

describe('语义符号：CTE 名字', () => {
  it('声明处、FROM 处、限定符处都能解析到 CTE', () => {
    expect(cteNameAt('WITH |recent AS (SELECT * FROM users) SELECT * FROM recent')).toBe('recent')
    expect(cteNameAt('WITH recent AS (SELECT * FROM users) SELECT * FROM |recent')).toBe('recent')
    expect(cteNameAt('WITH recent AS (SELECT * FROM users) SELECT |recent.id FROM recent')).toBe('recent')
  })

  it('别名遮蔽、普通标识符、字符串都不算 CTE 名', () => {
    // `FROM recent r` 里的 r 是别名（由别名解析负责），不是 CTE 名
    expect(cteNameAt('WITH recent AS (SELECT * FROM users) SELECT 1 FROM recent |r')).toBeNull()
    expect(cteNameAt('SELECT * FROM |users')).toBeNull()
    expect(cteNameAt("WITH recent AS (SELECT * FROM users) SELECT '|recent' FROM recent")).toBeNull()
  })

  it('引用包含结构位置（FROM）与限定符位置（recent.id）', () => {
    expect(cteReferenceTextsOf(
      'WITH |recent AS (SELECT * FROM users) SELECT recent.id FROM recent',
    )).toEqual(['recent', 'recent'])
  })

  it('起了别名时只改 CTE 名，别名引用不动', () => {
    expect(cteReferenceTextsOf(
      'WITH |recent AS (SELECT * FROM users) SELECT r.id FROM recent r',
    )).toEqual(['recent'])
  })

  it('字符串 / 注释 / 别的语句都不算引用', () => {
    expect(cteReferenceTextsOf(
      "WITH |recent AS (SELECT 1) SELECT * FROM recent WHERE note = 'recent'",
    )).toEqual(['recent'])
    expect(cteReferenceTextsOf(
      'WITH |recent AS (SELECT 1) SELECT * FROM recent; SELECT * FROM recent',
    )).toEqual(['recent'])
  })

  it('带引号的 CTE 名整段命中（含引号），替换后不会剩下半截引号', () => {
    expect(cteNameAt('WITH `|recent` AS (SELECT 1) SELECT * FROM `recent`')).toBe('recent')
    expect(cteReferenceTextsOf(
      'WITH `|recent` AS (SELECT 1) SELECT * FROM `recent`',
    )).toEqual(['`recent`'])
  })

  it('多个 CTE 各管各的（按声明顺序解析，后续可引用前面的）', () => {
    expect(cteReferenceTextsOf(
      'WITH a AS (SELECT * FROM users), |b AS (SELECT * FROM a) SELECT * FROM b',
    )).toEqual(['b'])
  })
})
