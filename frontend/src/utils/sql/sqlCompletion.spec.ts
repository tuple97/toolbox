/**
 * SQL 补全的作用域用例。
 *
 * 直接构造 EditorState 并注入静态 MetadataProvider —— `collectCompletions`
 * 是纯函数（只依赖 EditorState，不依赖 EditorView / DOM / pinia），
 * 因此这些用例跑在 node 环境下，不需要 jsdom。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { collectCompletions, columnHoverAt, qualifierBeforeCursor } from '@/utils/sql/sqlCompletion'
import { sortByRank } from '@/utils/sql/sqlCompletionRank'
import { scanClause } from '@/utils/sql/sqlCursor'
import type { Completion } from '@codemirror/autocomplete'
import type {
  ColumnCompletion,
  CompletionRuntime,
  MetadataProvider,
} from '@/utils/sql/sqlCompletion'

/** 静态元数据：testdb 下 users(id, name)、orders(id) */
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
      return [{ name: 'id', dataType: 'int', comment: '' }]
    }
    return []
  },
}

/** 用 `|` 标记光标位置，返回候选项 */
function itemsOf(docWithCursor: string, mode: CompletionRuntime['mode'] = 'sql'): Completion[] {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })

  const bundle = collectCompletions(state, pos, {
    mode,
    sql: mode === 'sql' ? { connId: 1, database: 'testdb', dbType: 'mysql' } : undefined,
    metadata,
  })
  return bundle?.options ?? []
}

/** 用 `|` 标记光标位置，返回候选 label 列表 */
function labelsOf(docWithCursor: string, mode: CompletionRuntime['mode'] = 'sql'): string[] {
  return itemsOf(docWithCursor, mode).map(item => item.label)
}

describe('SQL 补全：作用域', () => {
  it('CTE 的列可用于点号补全', () => {
    expect(labelsOf('WITH a AS (SELECT 1 AS x) SELECT * FROM a WHERE a.|')).toContain('x')
  })

  it('派生表别名后的列来自静态解析', () => {
    expect(labelsOf('SELECT * FROM (SELECT id FROM users) u WHERE u.|')).toContain('id')
  })

  it('派生表里的 SELECT * 用底层表的列展开', () => {
    const labels = labelsOf('SELECT t1.* FROM (SELECT * FROM users) t1 WHERE t1.|')
    expect(labels).toContain('id')
    expect(labels).toContain('name')
  })

  it('派生表里的 t.* 按限定符定位来源表', () => {
    const labels = labelsOf('SELECT x.* FROM (SELECT u.* FROM users u) x WHERE x.|')
    expect(labels).toContain('id')
    expect(labels).toContain('name')
  })

  it('多层派生的 * 逐层展开', () => {
    const labels = labelsOf(
      'SELECT t2.* FROM (SELECT * FROM (SELECT * FROM orders) t1) t2 WHERE t2.|',
    )
    expect(labels).toContain('id')
  })

  it('内外层同名别名：内层遮蔽外层', () => {
    const labels = labelsOf(
      'SELECT * FROM (SELECT uid FROM users) x WHERE x.uid IN (SELECT oid FROM (SELECT oid FROM orders) x WHERE x.|)',
    )
    expect(labels).toContain('oid')
    // 外层 x 指向 users，其列不应泄漏到内层
    expect(labels).not.toContain('uid')
  })

  it('非点号补全同样按层遮蔽别名', () => {
    const labels = labelsOf(
      'SELECT * FROM (SELECT uid FROM users) x WHERE 1 IN (SELECT oid FROM (SELECT oid FROM orders) x WHERE |)',
    )
    expect(labels).toContain('oid')
    expect(labels).not.toContain('uid')
  })

  it('递归 CTE 的显式列清单可用', () => {
    const labels = labelsOf(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT * FROM t WHERE t.|',
    )
    expect(labels).toContain('n')
  })

  it('依赖链：后一个 CTE 用前一个的输出列展开 *', () => {
    const labels = labelsOf(
      'WITH a AS (SELECT id FROM users), b AS (SELECT * FROM a) SELECT * FROM b WHERE b.|',
    )
    expect(labels).toContain('id')
  })

  it('光标落在 CTE 定义体内时不做自引用补全', () => {
    // `t.` 位于定义体内，此时 t 不应从可见 CTE 里取列
    const labels = labelsOf(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE t.|) SELECT * FROM t',
    )
    expect(labels).not.toContain('n')
  })

  it('跨语句不共享别名（第二条语句看不到第一条的表别名）', () => {
    const labels = labelsOf('SELECT * FROM users u; SELECT * FROM |')
    expect(labels).not.toContain('u')
    expect(labels).toContain('users')
  })

  it('字符串内不补全', () => {
    expect(labelsOf("SELECT * FROM users WHERE name = '|'")).toEqual([])
  })

  it('注释内不补全', () => {
    expect(labelsOf('SELECT 1 -- |')).toEqual([])
  })
})

describe('SQL 补全：位置与候选收敛', () => {
  it('表达式位置在语句末尾 / 新起一行时同样能拿到表列', () => {
    expect(labelsOf('SELECT * FROM users WHERE |')).toContain('name')
    expect(labelsOf('SELECT * FROM users WHERE \n  |')).toContain('name')
    expect(labelsOf('SELECT * FROM users ORDER BY |')).toContain('name')
    expect(labelsOf('SELECT * FROM users GROUP BY |')).toContain('name')
    expect(labelsOf('UPDATE users SET |')).toContain('name')
    expect(labelsOf('SELECT * FROM users u JOIN orders o ON |')).toContain('name')
  })

  it('子查询的 SELECT 后面先给列，且不出现语句级关键字', () => {
    const labels = labelsOf('SELECT t1.created_at FROM (SELECT | FROM users) t1')
    expect(labels.slice(0, 2)).toEqual(['id', 'name'])
    expect(labels).not.toContain('ALTER TABLE')
    expect(labels).not.toContain('SHOW TABLES')
  })

  it('语句开头保留语句级关键字', () => {
    expect(labelsOf('|')).toContain('ALTER TABLE')
  })

  it('表名位置只给表与库', () => {
    expect(labelsOf('SELECT * FROM |')).toEqual(['users', 'orders', 'testdb'])
  })

  it('列候选的权重高于关键字', () => {
    const items = itemsOf('SELECT * FROM users WHERE |')
    const column = items.find(item => item.label === 'name')?.boost ?? 0
    const keyword = items.find(item => item.label === 'AND')?.boost ?? 0
    expect(column).toBeGreaterThan(keyword)
  })

  it('新语句（上一条已结束）不受上一条表影响', () => {
    const labels = labelsOf('SELECT * FROM users;\n|')
    expect(labels).toContain('users')
    expect(labels).not.toContain('name')
  })
})

describe('SQL 补全：定义体内不继承外层作用域', () => {
  it('派生表体内的子查询看不到外层别名', () => {
    const labels = labelsOf('SELECT t1.email FROM (SELECT | FROM `users`) t1')
    expect(labels).toContain('name')
    expect(labels).not.toContain('t1')
  })

  it('CTE 定义体内看不到同一语句的其它表', () => {
    const labels = labelsOf('WITH c AS (SELECT | FROM users) SELECT * FROM c JOIN orders o ON 1 = 1')
    expect(labels).toContain('name')
    expect(labels).not.toContain('c')
    expect(labels).not.toContain('o')
  })

  it('表达式位置的子查询仍能看到外层表（相关子查询）', () => {
    expect(
      labelsOf('SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders WHERE u.|)'),
    ).toContain('name')
  })

  it('多层派生：最外层别名不会漏进内层', () => {
    const labels = labelsOf('SELECT t2.* FROM (SELECT * FROM (SELECT | FROM orders) t1) t2')
    expect(labels).not.toContain('t1')
    expect(labels).not.toContain('t2')
  })

  it('派生表里的 * 也能解析到 CTE 的输出列', () => {
    const labels = labelsOf(
      'WITH a AS (SELECT id, name FROM users) SELECT * FROM (SELECT * FROM a) t WHERE t.|',
    )
    expect(labels).toContain('name')
  })
})

describe('SQL 补全：别名位置与关键字矩阵', () => {
  it('AS 之后（别名位置）不弹任何候选', () => {
    expect(labelsOf('SELECT t1.* FROM (SELECT * FROM `users`) AS |t1')).toEqual([])
    expect(labelsOf('SELECT name AS | FROM users')).toEqual([])
  })

  it('别名写完后（AS t1 |）按「表之后」给子句关键字，不给函数与自身别名', () => {
    const labels = labelsOf('SELECT t1.* FROM (SELECT * FROM `users`) AS t1\n|')
    expect(labels).toContain('WHERE')
    expect(labels).toContain('JOIN')
    // 函数只属于表达式位置
    expect(labels).not.toContain('COUNT')
    // 刚刚定义的别名不该再作为候选
    expect(labels).not.toContain('t1')
    // 语句级 / DDL 关键字不属于这里
    expect(labels).not.toContain('ALTER TABLE')
  })

  it('表名位置只给表与库', () => {
    expect(labelsOf('SELECT * FROM users, |')).toEqual(['users', 'orders', 'testdb'])
  })

  it('表之后给连接 / 子句关键字，不给表达式关键字与函数', () => {
    const labels = labelsOf('SELECT * FROM users |')
    expect(labels).toContain('JOIN')
    expect(labels).toContain('WHERE')
    expect(labels).toContain('GROUP BY')
    expect(labels).toContain('AS')
    expect(labels).not.toContain('AND')
    expect(labels).not.toContain('COUNT')
  })

  it('表达式位置给表达式关键字、函数与子句关键字，不给 DDL', () => {
    const labels = labelsOf('SELECT * FROM users WHERE |')
    expect(labels).toContain('AND')
    expect(labels).toContain('LIKE')
    expect(labels).toContain('COUNT')
    /*
     * 条件刚开头（`WHERE |`）不给 GROUP BY / ORDER BY / FROM / JOIN ——
     * 这是槽位（where-expression）决定的「资格」，不是排序能把它们压下去的事。
     * 条件写完（`WHERE a = 1 |`）之后 GROUP BY 才该出现，见下一条断言。
     */
    expect(labels).not.toContain('GROUP BY')
    expect(labels).not.toContain('FROM')
    expect(labels).not.toContain('JOIN')
    expect(labelsOf('SELECT * FROM users WHERE id = 1 |')).toContain('GROUP BY')
    expect(labels).not.toContain('ALTER TABLE')
    expect(labels).not.toContain('CREATE TABLE')
  })

  it('语句开头给全量关键字（含 DDL），但不给函数', () => {
    const labels = labelsOf('|')
    expect(labels).toContain('ALTER TABLE')
    expect(labels).toContain('SELECT')
    expect(labels).toContain('WITH')
    expect(labels).not.toContain('COUNT')
  })
})

describe('SQL 补全：派生列的来源与类型', () => {
  /** 取候选项携带的列描述（提示栏据此渲染类型 / 来源 / 注释） */
  function columnDetailOf(docWithCursor: string, label: string) {
    const item = itemsOf(docWithCursor).find(candidate => candidate.label === label)
    return item ? (item as ColumnCompletion).columnDetail : undefined
  }

  it('SELECT * 展开的列带来源表、类型与注释', () => {
    const detail = columnDetailOf('SELECT * FROM (SELECT * FROM users) t1 WHERE t1.|', 'name')
    expect(detail?.from).toBe('users')
    expect(detail?.dataType).toBe('varchar')
    expect(detail?.comment).toBe('名称')
  })

  it('显式列清单也能溯源到来源表与类型', () => {
    const detail = columnDetailOf('SELECT * FROM (SELECT name FROM users) t1 WHERE t1.|', 'name')
    expect(detail?.from).toBe('users')
    expect(detail?.dataType).toBe('varchar')
  })

  it('多表派生的列按限定符归属各自来源', () => {
    const sql = 'SELECT * FROM (SELECT u.name, o.id FROM users u JOIN orders o ON 1 = 1) t WHERE t.|'
    // name 来自 users（varchar），id 来自 orders（int），同名 id 不再混淆
    expect(columnDetailOf(sql, 'name')?.from).toBe('users')
    expect(columnDetailOf(sql, 'name')?.dataType).toBe('varchar')
    expect(columnDetailOf(sql, 'id')?.from).toBe('orders')
    expect(columnDetailOf(sql, 'id')?.dataType).toBe('int')
  })

  it('派生表别名的提示里点出来源表', () => {
    const item = itemsOf('SELECT * FROM (SELECT * FROM users) t1 WHERE |')
      .find(candidate => candidate.label === 't1')
    expect(item?.detail).toContain('users')
  })

  it('无法溯源的表达式列没有类型与注释', () => {
    const detail = columnDetailOf(
      'SELECT * FROM (SELECT COUNT(*) AS total FROM users) t1 WHERE t1.|',
      'total',
    )
    expect(detail).toBeTruthy()
    // 只剩当前作用域的别名，不编造来源与类型
    expect(detail?.from).toBe('t1')
    expect(detail?.dataType).toBeUndefined()
    expect(detail?.comment).toBeUndefined()
  })
})

describe('补全位置与次序（回归）', () => {
  it('FR 前缀：子句关键字排在函数前面', () => {
    const items = itemsOf('SELECT * FR|')
    const keyword = items.find(item => item.label === 'FROM')
    const fn = items.find(item => item.label === 'FROM_UNIXTIME')
    expect(keyword).toBeTruthy()
    expect(fn).toBeTruthy()

    /*
     * 两者同属「前缀命中」档，先后由 boost 的类别层次决定：
     * 结构关键字（FROM）压过函数（FROM_UNIXTIME）——用户在这里接的是子句骨架。
     */
    expect(sortByRank([fn!, keyword!], 'FR')[0].label).toBe('FROM')
  })

  it('扫描层区分「紧贴关键字」与「关键字后空位」', () => {
    // 三种情形各有语义：紧贴关键字 / 紧贴的名字被让过 / 真的空出槽位
    expect(scanClause('SELECT * FROM').tight).toBe('keyword')
    expect(scanClause('SELECT * FROM or').tight).toBe('name')
    expect(scanClause('SELECT * FROM ').tight).toBe('none')
  })

  it('FROM| 不给表与库（还在写 FROM 这个词）', () => {
    const labels = labelsOf('SELECT * FROM|')
    expect(labels).not.toContain('users')
    expect(labels).not.toContain('testdb')
  })

  it('FROM | 才给表与库', () => {
    const labels = labelsOf('SELECT * FROM |')
    expect(labels).toContain('users')
    expect(labels).toContain('testdb')
  })

  it('INSERT INTO| 同样不给表与库', () => {
    const labels = labelsOf('INSERT INTO|')
    expect(labels).not.toContain('users')
    expect(labels).not.toContain('testdb')
  })

  it('紧贴的是正在输入的名字（FROM ord|）：表名与库名一起给', () => {
    expect(labelsOf('SELECT * FROM or|')).toContain('orders')
    /*
     * 库名同样是「正在写库/表名」时的合法选项：选定库名后接着敲 `.`
     * 就能展开它的表。表与库的资格完全一致，由槽位层决定。
     */
    expect(labelsOf('SELECT * FROM te|')).toContain('testdb')
  })

  it('表位置输入部分表名（FROM d| / FROM de| / FROM us|）：表名照给', () => {
    /*
     * 症状回归：以前只有「恰好是关键字」的紧贴词（`or`）才被让过，
     * `d` / `de` 这类非关键字被当成「表已写完」⇒ 表名候选整批消失，
     * 只剩 ORDER BY 这些子句关键字。
     *
     * 注：候选还要过 CodeMirror 的前缀模糊匹配，所以断言按「哪个前缀命中哪张表」写。
     */
    const labels = labelsOf('SELECT * FROM d|')
    expect(labels).toContain('orders')
    expect(labels).not.toContain('ORDER BY')
    // 库名与表名一起给：`FROM d|` 里也可能是想写库名，选完敲 `.` 再展开表
    expect(labels).toContain('testdb')
    expect(labelsOf('SELECT * FROM us|')).toContain('users')
    expect(labelsOf('SELECT * FROM ord|')).toContain('orders')
    // 不是 FROM 专属：其它「后面接表」的关键字同样受益
    expect(labelsOf('INSERT INTO us|')).toContain('users')
    expect(labelsOf('UPDATE us|')).toContain('users')
    // 库限定名写到一半：库名已写、表名正在写
    expect(labelsOf('SELECT * FROM testdb.us|')).toContain('users')
  })

  it('扫描层：紧贴光标的非关键字词一律是「正在输入的名字」', () => {
    // 表位置：任意前缀都还是表位置（判据是词的身份，不是它长什么样）
    expect(scanClause('SELECT * FROM d').kind).toBe('source')
    expect(scanClause('SELECT * FROM users').kind).toBe('source')
    // `user` 是需要引用符的保留字，但不是关键字 —— 不能因此当子句
    expect(scanClause('SELECT * FROM user').kind).toBe('source')
    // 库限定名写到一半：库名已写、表名正在写
    expect(scanClause('SELECT * FROM testdb.us').kind).toBe('source')
    // 逗号之后的下一个来源同理
    expect(scanClause('SELECT * FROM users, ord').kind).toBe('source')
  })

  it('名字写完（后面落空格）才转为「表之后」，别名不算来源', () => {
    // 边界：让过只针对紧贴光标的词
    expect(scanClause('SELECT * FROM users ').kind).toBe('afterSource')
    expect(scanClause('SELECT * FROM users u').kind).toBe('afterSource')
    // 紧贴的仍是关键字时由关键字决定位置，不受「让过」影响
    expect(scanClause('SELECT * FROM users WHERE').kind).toBe('column')
    expect(scanClause('SELECT * FROM users ORDER BY id DESC').kind).toBe('column')
  })

  it('ON| / WHERE| 紧贴：不给库名', () => {
    expect(labelsOf('SELECT * FROM users u JOIN orders o ON|')).not.toContain('testdb')
    expect(labelsOf('SELECT * FROM users u WHERE|')).not.toContain('testdb')
  })

  it('语句末尾的普通换行仍属于上一条语句', () => {
    const labels = labelsOf('SELECT * FROM users\n|')
    expect(labels).toContain('WHERE')
    expect(labels).not.toContain('SELECT')
  })

  it('空行之后输入 S：给语句关键字，而不是上一条的子句关键字', () => {
    expect(labelsOf('SELECT * FROM users\n\nS|')).toContain('SELECT')
  })

  it('空行之后不再给出上一条语句的列', () => {
    const items = itemsOf('SELECT * FROM users AS t1\n\nS|')
    expect(items.some(item => item.type === 'field')).toBe(false)
  })

  it('多空行 / 分号后空行 / 空行后有注释，都算新语句', () => {
    expect(labelsOf('SELECT * FROM users\n\n\nS|')).toContain('SELECT')
    expect(labelsOf('SELECT * FROM users;\n\nS|')).toContain('SELECT')
    expect(labelsOf('SELECT * FROM users\n\n-- 下一条\nS|')).toContain('SELECT')
  })

  it('空行后写完整语句再点号：不继承上一条的别名', () => {
    const labels = labelsOf('SELECT * FROM users AS t1\n\nSELECT t1.|')
    expect(labels).not.toContain('name')
  })

  it('真实场景：上一条 SQL 后空一行输入 S 应开始新 SQL', () => {
    const labels = labelsOf(
      'SELECT t1.email, t1.id, t1.is_active, t1.password_hash, t1.updated_at '
      + 'FROM `users` AS t1\n\nS|',
    )
    expect(labels).toContain('SELECT')
    // 上一条 SQL 的 clause context（表来源之后的关键字）不该再出现
    expect(labels).not.toContain('AS')
    expect(labels).not.toContain('OFFSET')
    expect(labels).not.toContain('VALUES')
  })

  it('语句内部的空行不切断作用域', () => {
    const labels = labelsOf('SELECT\n\nname| FROM users')
    expect(labels).toContain('name')
  })

  it('点号紧贴光标：替换范围只有词，限定符由候选自带', () => {
    const doc = 'SELECT u.| FROM users u'
    const pos = doc.indexOf('|')
    const text = doc.replace('|', '')
    const state = EditorState.create({ doc: text, extensions: [sql({ dialect: MySQL })] })
    const bundle = collectCompletions(state, pos, {
      mode: 'sql',
      sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
      metadata,
    })

    /*
     * 替换范围里的文本就是编辑器用来匹配候选项的输入：必须是词（这里为空），
     * 不能含 `u.` —— 含了就一个列候选都匹配不上（搜索名是裸列名）。
     */
    expect(bundle).toBeTruthy()
    expect(text.slice(bundle!.from, bundle!.to)).toBe('')
    const name = (bundle!.options as ColumnCompletion[]).find(item => item.label === 'name')
    expect(name?.columnPrefix).toBe('u.')
    expect(name?.columnInsert).toBe('u.name')
  })
})

describe('列插入：点号补全的限定符', () => {
  it('读出光标左侧的别名', () => {
    const simple = 'SELECT t1.'
    expect(qualifierBeforeCursor(simple, simple.length)).toBe('t1.')

    // 补全插入时传入的是替换起点（当前正在输入的词的首字符），限定符紧贴在它左侧
    const typing = 'SELECT t1.ema'
    expect(qualifierBeforeCursor(typing, 'SELECT t1.'.length)).toBe('t1.')

    const quoted = 'SELECT `db`.`t`.'
    expect(qualifierBeforeCursor(quoted, quoted.length)).toBe('`db`.`t`.')
  })

  it('没有点号时不加限定符', () => {
    const plain = 'SELECT ema'
    expect(qualifierBeforeCursor(plain, plain.length)).toBe('')

    const table = 'SELECT t1'
    expect(qualifierBeforeCursor(table, table.length)).toBe('')

    // 点号与别名之间有空格的写法不做处理（识别不出就不加前缀，避免猜错）
    const spaced = 'SELECT t1 .'
    expect(qualifierBeforeCursor(spaced, spaced.length)).toBe('')
  })
})

describe('SQL 补全：列悬停信息', () => {
  /** 用 `|` 标出要悬停的列名位置，返回该处的列信息 */
  function hoverAt(docWithCursor: string) {
    const pos = docWithCursor.indexOf('|')
    const doc = docWithCursor.replace('|', '')
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    return columnHoverAt(state, pos, {
      mode: 'sql',
      sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
      metadata,
    })
  }

  it('物理表的列给出表名、类型与注释', () => {
    const hover = hoverAt('SELECT |name FROM users')
    expect(hover?.info.name).toBe('name')
    expect(hover?.info.table).toBe('users')
    expect(hover?.info.dataType).toBe('varchar')
    expect(hover?.info.comment).toBe('名称')
    expect(hover?.info.derived).toBeUndefined()
  })

  it('派生表的列溯源到物理表并标注派生', () => {
    const hover = hoverAt('SELECT * FROM (SELECT * FROM users) t1 WHERE t1.|name')
    expect(hover?.info.table).toBe('users')
    expect(hover?.info.dataType).toBe('varchar')
    expect(hover?.info.derived).toBe(true)
  })

  it('限定符精确匹配来源表（同名列不串表）', () => {
    const hover = hoverAt('SELECT * FROM users u JOIN orders o ON 1 = 1 WHERE u.|id')
    expect(hover?.info.table).toBe('users')
    expect(hover?.info.dataType).toBe('int')
  })

  it('悬停在表名 / 限定符 / 数字上都不提示', () => {
    expect(hoverAt('SELECT * FROM |users')).toBeNull()
    expect(hoverAt('SELECT * FROM users u WHERE |u.id = 1')).toBeNull()
    expect(hoverAt('SELECT 1 AS n FROM users WHERE n = |1')).toBeNull()
  })

  it('字符串与注释里不提示', () => {
    expect(hoverAt("SELECT * FROM users WHERE name = '|name'")).toBeNull()
    expect(hoverAt('SELECT * FROM users -- |name')).toBeNull()
  })

  it('未登记连接时不提示', () => {
    const doc = 'SELECT name FROM users'
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    expect(columnHoverAt(state, 7, { mode: 'sql', metadata })).toBeNull()
  })
})

/**
 * 库限定名 + 已输入前缀。
 *
 * 回归点：限定符必须取自光标分析层（按词首回看），只看「光标是否紧邻点号」
 * 会在 `` `other`.u| `` 时丢掉库名，退化成「当前库的表」——
 * 于是当前库里恰好同名的表能蒙对，不同名的表永远补不出来。
 */
describe('SQL 补全：库限定名 + 前缀', () => {
  /** 第二个库：与当前库（testdb）的表名刻意不同，才能验出限定符有没有生效 */
  const twoDbMetadata: MetadataProvider = {
    databases: () => ['testdb', 'other'],
    tables: (_connId, database) => {
      if (database === 'testdb') {
        return ['users', 'orders']
      }
      if (database === 'other') {
        return ['device_log', 'user_roles']
      }
      return []
    },
    columns: () => [],
  }

  /** 当前库固定为 testdb，限定符指向 other */
  function labelsInOther(docWithCursor: string): string[] {
    const pos = docWithCursor.indexOf('|')
    const doc = docWithCursor.replace('|', '')
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    const bundle = collectCompletions(state, pos, {
      mode: 'sql',
      sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
      metadata: twoDbMetadata,
    })
    return (bundle?.options ?? []).map(item => item.label)
  }

  it('点号后为空：给限定库的全部表', () => {
    const labels = labelsInOther('SELECT * FROM `other`.|')
    expect(labels).toContain('device_log')
    expect(labels).toContain('user_roles')
    expect(labels).not.toContain('users')
  })

  it('点号后已打前缀：仍按限定库过滤（`other`.u|）', () => {
    const labels = labelsInOther('SELECT * FROM `other`.u|')
    expect(labels).toContain('user_roles')
    // 当前库的同名前缀表不能混进来
    expect(labels).not.toContain('users')
  })

  it('前缀正好是子句关键字（use|）也不当关键字处理', () => {
    // `use` 在 TABLE_CLAUSE_KEYWORDS 里；限定名之后的它只能是表名的一部分
    expect(scanClause('SELECT * FROM `other`.use').kind).toBe('source')
    expect(labelsInOther('SELECT * FROM `other`.use|')).toContain('user_roles')
  })
})
