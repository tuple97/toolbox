/**
 * 系统库可见性策略的用例。
 *
 * 两条边界必须同时成立，缺一条这个功能就不敢用：
 *  1. 关掉设置后，**候选与下拉**不再主动列出系统库；
 *  2. 显式写下 `mysql.user` **仍然能解析** —— 隐藏是展示策略，不是语法限制。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import {
  filterDatabaseInfos,
  filterDatabases,
  isDatabaseVisible,
  isSystemDatabase,
  isSystemDatabaseItem,
  parseShowSystemDatabases,
} from '@/utils/sql/sqlVisibility'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime, MetadataProvider } from '@/utils/sql/sqlCompletion'

describe('系统库判定：按方言，不靠前缀猜', () => {
  it('MySQL 的四个系统库', () => {
    for (const name of ['information_schema', 'mysql', 'performance_schema', 'sys']) {
      expect(isSystemDatabase(name, 'mysql')).toBe(true)
    }
    expect(isSystemDatabase('business_db', 'mysql')).toBe(false)
    // 前缀像系统库但其实是业务库：绝不能藏
    expect(isSystemDatabase('sys_logs', 'mysql')).toBe(false)
    expect(isSystemDatabase('mysql_backup', 'mysql')).toBe(false)
  })

  it('PostgreSQL 的 pg_* 系统 schema 与临时 schema', () => {
    expect(isSystemDatabase('pg_catalog', 'postgres')).toBe(true)
    expect(isSystemDatabase('information_schema', 'postgres')).toBe(true)
    expect(isSystemDatabase('pg_toast', 'postgres')).toBe(true)
    expect(isSystemDatabase('pg_toast_16385', 'postgres')).toBe(true)
    expect(isSystemDatabase('pg_temp_3', 'postgres')).toBe(true)
    expect(isSystemDatabase('public', 'postgres')).toBe(false)
    // MySQL 的 mysql 库在 PG 下不是系统对象（方言不同，判定也不同）
    expect(isSystemDatabase('mysql', 'postgres')).toBe(false)
  })

  it('大小写与空白不敏感', () => {
    expect(isSystemDatabase('  MySQL  ', 'mysql')).toBe(true)
  })
})

describe('可见性策略：下拉与候选共用', () => {
  const names = ['information_schema', 'mysql', 'business_db', 'sys_logs']

  it('开启时原样返回（顺序不变）', () => {
    expect(filterDatabases(names, 'mysql', true)).toEqual(names)
  })

  it('关闭时去掉系统库，保留业务库与「像系统库的业务库」', () => {
    expect(filterDatabases(names, 'mysql', false)).toEqual(['business_db', 'sys_logs'])
  })

  it('isDatabaseVisible 是同一套判定', () => {
    expect(isDatabaseVisible('mysql', 'mysql', false)).toBe(false)
    expect(isDatabaseVisible('mysql', 'mysql', true)).toBe(true)
    expect(isDatabaseVisible('business_db', 'mysql', false)).toBe(true)
  })

  it('设置项解析：默认显示，只有明确 false 才隐藏', () => {
    expect(parseShowSystemDatabases(undefined)).toBe(true)
    expect(parseShowSystemDatabases('true')).toBe(true)
    expect(parseShowSystemDatabases('')).toBe(true)
    expect(parseShowSystemDatabases('whatever')).toBe(true)
    expect(parseShowSystemDatabases('false')).toBe(false)
  })
})

/** 只回数据库名候选的 label */
const metadata: MetadataProvider = {
  databases: () => ['information_schema', 'mysql', 'business_db'],
  tables: (_connId, database) => (database === 'mysql' ? ['user'] : ['orders']),
  columns: (_connId, _database, table) => (table === 'user'
    ? [{ name: 'host', dataType: 'varchar(60)', comment: '' }]
    : [{ name: 'id', dataType: 'int', comment: '' }]),
}

function labelsAt(
  docWithCursor: string,
  showSystemDatabases: boolean,
  provider: MetadataProvider = metadata,
) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const runtime: CompletionRuntime = {
    mode: 'sql',
    sql: { connId: 1, database: 'business_db', dbType: 'mysql' },
    metadata: provider,
    featureFlags: { showSystemDatabases },
  }
  return (collectCompletions(state, pos, runtime)?.options ?? []).map(option => option.label)
}

describe('可见性：后端标记优先（判定来自适配层）', () => {
  it('标记说是系统库就是 —— 哪怕方言表不认识这个名字', () => {
    const list = [
      { name: 'my_internal_catalog', isSystem: true },
      { name: 'business_db', isSystem: false },
    ]
    expect(filterDatabaseInfos(list, 'mysql', false)).toEqual([{ name: 'business_db', isSystem: false }])
  })

  it('标记说不是就不是 —— 哪怕名字撞上方言表（自建库真叫 sys 也留着）', () => {
    const list = [{ name: 'sys', isSystem: false }]
    expect(filterDatabaseInfos(list, 'mysql', false)).toEqual(list)
  })

  it('没有标记时退回「名字 + 方言表」（只给名字的场景）', () => {
    expect(filterDatabaseInfos([{ name: 'mysql' }, { name: 'business_db' }], 'mysql', false))
      .toEqual([{ name: 'business_db' }])
  })

  it('开启时原样返回（顺序不变）', () => {
    const list = [{ name: 'mysql', isSystem: true }, { name: 'business_db', isSystem: false }]
    expect(filterDatabaseInfos(list, 'mysql', true)).toEqual(list)
  })

  it('isSystemDatabaseItem 是唯一判定入口', () => {
    expect(isSystemDatabaseItem({ name: 'whatever', isSystem: true }, 'mysql')).toBe(true)
    expect(isSystemDatabaseItem({ name: 'mysql' }, 'mysql')).toBe(true)
    expect(isSystemDatabaseItem({ name: 'mysql', isSystem: false }, 'mysql')).toBe(false)
  })
})

describe('候选生成：系统库按设置出现', () => {
  it('默认（开启）时库名候选里有系统库', () => {
    const labels = labelsAt('SELECT * FROM |', true)
    expect(labels).toContain('mysql')
    expect(labels).toContain('information_schema')
    expect(labels).toContain('business_db')
  })

  it('关闭后候选里不再出现系统库，业务库照旧', () => {
    const labels = labelsAt('SELECT * FROM |', false)
    expect(labels).not.toContain('mysql')
    expect(labels).not.toContain('information_schema')
    expect(labels).toContain('business_db')
  })

  it('提供 databaseInfos 时按**后端标记**过滤（名字撞方言表的自建库不会被误藏）', () => {
    const provider: MetadataProvider = {
      ...metadata,
      databases: () => ['information_schema', 'sys', 'business_db'],
      databaseInfos: () => [
        { name: 'information_schema', isSystem: true },
        { name: 'sys', isSystem: false },
        { name: 'business_db', isSystem: false },
      ],
    }
    const labels = labelsAt('SELECT * FROM |', false, provider)
    expect(labels).not.toContain('information_schema')
    // `sys` 在这里是业务库（后端说 isSystem: false）：必须留下
    expect(labels).toContain('sys')
    expect(labels).toContain('business_db')
  })

  it('显式写下系统库时仍然解析（隐藏 ≠ 非法）', () => {
    // 一段就是库名 → 给该库的表（这条路径不经过可见性过滤）
    expect(labelsAt('SELECT * FROM mysql.|', false)).toEqual(['user'])
    // 两段显式写明库.表 → 直接给该表的字段
    expect(labelsAt('SELECT mysql.user.|', false)).toEqual(['host'])
    expect(labelsAt('SELECT mysql.user.|', true)).toEqual(['host'])
  })
})
