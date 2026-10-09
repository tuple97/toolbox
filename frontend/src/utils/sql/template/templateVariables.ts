/**
 * 变量配置 → 补全用的模板变量。
 *
 * 变量配置里有「控件类型 + 数据类型」，补全关心的是「模板里它是什么值」：
 * 数组（range 用）、数字（比较用）、字符串…… 这里做一次映射，
 * 让参数位排序与点号取值能用上类型信息，而不是只看名字。
 */
import type { VariableComponent, VariableDataType, VariableConfig } from '@/types'
import type { TemplateValueType } from './templateFunctions'

/** 补全用的模板变量（`TemplateVariable` 的结构子集） */
export interface TemplateVariableLike {
  name: string
  label?: string
  type?: TemplateValueType
  elementType?: TemplateValueType
}

/** 把变量配置映射成模板变量 */
export function templateVariablesOf(configs: VariableConfig[]): TemplateVariableLike[] {
  return configs.map(config => ({
    name: config.name,
    label: config.label,
    ...valueShapeOf(config.component, config.dataType),
  }))
}

/** 由控件类型与数据类型推导「值的形状」 */
function valueShapeOf(
  component: VariableComponent,
  dataType: VariableDataType,
): { type: TemplateValueType, elementType?: TemplateValueType } {
  switch (component) {
    // 多选在模板里就是一个数组，适合 `{{range 变量}}`
    case 'multi-select':
      return { type: 'array', elementType: 'string' }
    case 'slider':
      return { type: 'number' }
    case 'switch':
      return { type: 'boolean' }
    default:
      return { type: scalarTypeOf(dataType) }
  }
}

/** 标量数据类型 → 模板值类型 */
function scalarTypeOf(dataType: VariableDataType): TemplateValueType {
  switch (dataType) {
    case 'int':
    case 'float':
      return 'number'
    case 'bool':
      return 'boolean'
    case 'string':
    case 'date':
      return 'string'
    default:
      return 'unknown'
  }
}
