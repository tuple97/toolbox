/** CREATE TABLE 生成器用例 */
import { describe, expect, it } from 'vitest'
import { createTableModelOf, generateCreateTableSql } from '@/utils/sql/ddl/sqlCreateTable'
import type { ExecutorColumn } from '@/types'

/** 元数据（顺序即 schema 定义顺序） */
const columns: ExecutorColumn[] = [
  { name: 'id', dataType: 'int', comment: '主键' },
  { name: 'username', dataType: 'varchar(255)', comment: '' },
  { name: 'email', dataType: 'varchar(255)', comment: '' },
  { name: 'created_at', dataType: 'datetime', comment: '' },
]

describe('CREATE TABLE：从元数据生成', () => {
  it('MySQL：列内注释、不编造未提供的信息', () => {
    const sql = generateCreateTableSql(
      createTableModelOf({ tableName: 'users', columns }),
      'mysql',
    )
    expect(sql).toBe([
      'CREATE TABLE `users` (',
      '  `id` int COMMENT \'主键\',',
      '  `username` varchar(255),',
      '  `email` varchar(255),',
      '  `created_at` datetime',
      ');',
    ].join('\n'))
    // 元数据没给的东西不许出现
    expect(sql).not.toContain('NOT NULL')
    expect(sql).not.toContain('DEFAULT')
    expect(sql).not.toContain('AUTO_INCREMENT')
    expect(sql).not.toContain('PRIMARY KEY')
    expect(sql).not.toContain('ENGINE')
  })

  it('列顺序与 schema 定义顺序一致（不重排）', () => {
    const sql = generateCreateTableSql(createTableModelOf({ tableName: 'users', columns }), 'mysql')
    const order = ['`id`', '`username`', '`email`', '`created_at`']
      .map(name => sql.indexOf(name))
    expect(order).toEqual([...order].sort((left, right) => left - right))
  })

  it('PostgreSQL：用双引号，注释走独立的 COMMENT ON COLUMN', () => {
    const sql = generateCreateTableSql(
      createTableModelOf({ tableName: 'users', columns }),
      'postgres',
    )
    expect(sql).toContain('CREATE TABLE "users" (\n  "id" int,\n')
    expect(sql).toContain('COMMENT ON COLUMN "users"."id" IS \'主键\';')
    // 列内不带 MySQL 风格的 COMMENT
    expect(sql).not.toContain('int COMMENT')
  })

  it('带 schema 时限定表名', () => {
    const sql = generateCreateTableSql(
      createTableModelOf({ schema: 'public', tableName: 'users', columns }),
      'postgres',
    )
    expect(sql).toContain('CREATE TABLE "public"."users" (')
  })

  it('模型提供了主键 / 外键 / 表选项时才生成对应子句', () => {
    const sql = generateCreateTableSql({
      tableName: 'orders',
      columns: [
        { name: 'id', dataType: 'int', nullable: false },
        { name: 'user_id', dataType: 'int' },
      ],
      primaryKeys: ['id'],
      foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
      tableComment: '订单',
      options: 'ENGINE=InnoDB',
    }, 'mysql')

    expect(sql).toContain('`id` int NOT NULL,')
    expect(sql).toContain('PRIMARY KEY (`id`)')
    expect(sql).toContain('FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)')
    expect(sql).toContain("COMMENT='订单'")
    expect(sql).toContain('ENGINE=InnoDB')
  })

  it('没有列信息时不输出半截 DDL', () => {
    expect(generateCreateTableSql(createTableModelOf({ tableName: 'users', columns: [] }), 'mysql'))
      .toBe('')
  })
})
