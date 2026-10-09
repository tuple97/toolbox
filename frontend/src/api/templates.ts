import {
  DeleteSqlTemplate,
  ExecuteTemplateQuery,
  ExtractTemplateVariables,
  GetSqlTemplate,
  ListSqlTemplates,
  PreviewTemplate,
  RenderExportTemplate,
  SaveSqlTemplate,
  ValidateScript,
  ValidateTemplate,
} from './bindings'
import type {
  QueryResult,
  SQLTemplate,
  TemplateExecuteRequest,
  TemplateListItem,
} from '@/types'

/** 默认页大小，需与后端 defaultPageSize 一致 */
export const DEFAULT_PAGE_SIZE = 50

function toTemplate(raw: {
  id: number
  connId: number
  name: string
  sqlText: string
  database?: string
  variables: string
  fieldMappings: string
  exportTemplates?: string
  preScript: string
  postScript: string
  enabled?: boolean
  pageSize?: number
}): SQLTemplate {
  return {
    id: raw.id,
    connId: raw.connId,
    name: raw.name,
    sqlText: raw.sqlText,
    database: raw.database ?? '',
    variables: raw.variables,
    fieldMappings: raw.fieldMappings,
    exportTemplates: raw.exportTemplates ?? '[]',
    preScript: raw.preScript,
    postScript: raw.postScript,
    // 缺字段时按启用处理
    enabled: raw.enabled !== false,
    pageSize: Number(raw.pageSize) || 0,
  }
}

export async function fetchTemplateList(): Promise<TemplateListItem[]> {
  const list = await ListSqlTemplates()
  return list.map(item => ({
    id: item.id,
    name: item.name,
    connId: item.connId,
    sqlText: item.sqlText,
    // 缺字段时按启用处理
    enabled: item.enabled !== false,
  }))
}

export async function fetchTemplate(id: number): Promise<SQLTemplate> {
  const raw = await GetSqlTemplate(id)
  if (!raw) {
    throw new Error(`模板不存在（id=${id}）`)
  }
  return toTemplate(raw)
}

/** 保存模板，id 为 0 时新增 */
export function persistTemplate(tpl: SQLTemplate): Promise<number> {
  return SaveSqlTemplate({ ...tpl, pageSize: tpl.pageSize ?? 0 })
}

export function removeTemplate(id: number): Promise<void> {
  return DeleteSqlTemplate(id)
}

export function extractVariables(sqlText: string): Promise<string[]> {
  return ExtractTemplateVariables(sqlText) as Promise<string[]>
}

export function previewTemplate(
  sqlText: string,
  variables: Record<string, unknown>,
): Promise<string> {
  return PreviewTemplate(sqlText, variables)
}

export function validateScript(source: string): Promise<void> {
  return ValidateScript(source)
}

/** 按导出模板渲染选中的结果行，返回逐行对应的文本 */
export function renderExportTemplate(
  content: string,
  rows: Array<Record<string, unknown>>,
): Promise<string[]> {
  return RenderExportTemplate(content, rows) as Promise<string[]>
}

/** 模板语法校验结果（校验失败也是正常返回值） */
export interface TemplateCheckResult {
  valid: boolean
  /** 出错行号（1 起），拿不到时为 0 */
  line: number
  /** 出错列号（1 起），拿不到时为 0 */
  column: number
  message: string
}

/** 校验模板语法（不依赖连接） */
export function validateTemplate(sqlText: string): Promise<TemplateCheckResult> {
  return ValidateTemplate(sqlText) as unknown as Promise<TemplateCheckResult>
}

/** 按模板 ID 执行查询；page 从 1 开始，传 0 表示本次不分页 */
export function executeTemplateQuery(req: TemplateExecuteRequest): Promise<QueryResult> {
  return ExecuteTemplateQuery({
    ...req,
    // 空库名由后端回落到连接默认库
    database: req.database ?? '',
    page: req.page ?? 0,
    pageSize: req.pageSize ?? 0,
    total: req.total ?? 0,
    countTotal: req.countTotal ?? false,
  }) as unknown as Promise<QueryResult>
}
