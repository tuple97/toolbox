/**
 * 模板作用域。
 *
 * 模板里 `{{ . }}` 的含义由上下文决定：
 *  - `{{with 对象}}` 里指向那个对象；
 *  - `{{range 数组}}` 里指向当前元素；
 *  - `{{range $i, $v := 数组}}` 里 `$i` / `$v` 是局部变量，且 `$v` 也是当前元素。
 *
 * 这里把「到光标为止」的块链折叠成一条作用域链：内层优先、`$局部变量` 只在
 * 自己的块内可见。补全据此决定 `.` 与点的取值该给什么，而不是把所有模板变量
 * 一股脑塞进去。
 */
import type { TemplateValueType } from './templateFunctions'
import { parseTemplateDocument } from './templateParser'
import type { TemplateBlockNode } from './templateParser'

/** 对象属性（模板变量的字段） */
export interface TemplateProperty {
  name: string
  type?: TemplateValueType
  /** 展示名 / 说明 */
  label?: string
  comment?: string
}

/** 作用域里的一个符号 */
export interface TemplateSymbol {
  name: string
  type: TemplateValueType
  label?: string
  properties?: TemplateProperty[]
  /** 数组元素类型（`range` 里推导 `.` 用） */
  elementType?: TemplateValueType
}

/** 作用域输入：模板变量与可选的属性来源 */
export interface TemplateScopeInput {
  /** 模板变量（只要求结构兼容，避免与补全模块循环依赖） */
  variables: Array<{
    name: string
    label?: string
    type?: TemplateValueType
    properties?: TemplateProperty[]
    elementType?: TemplateValueType
  }>
}

/** 一条作用域链 */
export interface TemplateScope {
  /** 本层可见的符号（内层优先） */
  symbols: Map<string, TemplateSymbol>
  parent: TemplateScope | null
  /** `.` 指向的值；null 表示当前没有可展开的上下文 */
  dot: TemplateSymbol | null
}

/** 建一个空作用域 */
function scopeOf(parent: TemplateScope | null, dot: TemplateSymbol | null = null): TemplateScope {
  return { symbols: new Map(), parent, dot }
}

/**
 * 折叠出光标处的作用域。
 *
 * @param text  模板文本（整段 SQL 也可以）
 * @param upTo  只解析到这个下标（通常是光标位置）
 * @param input 模板变量
 */
export function buildTemplateScope(
  text: string,
  upTo: number,
  input: TemplateScopeInput,
): TemplateScope {
  const document = parseTemplateDocument(text.slice(0, upTo))
  return scopeFromUnclosedBlocks(input, document.unclosedBlocks)
}

/**
 * 由「未闭合块链」折叠作用域。
 *
 * 补全路径上块链已经解析过了（上下文里带着），这里直接消费，
 * 不用为了作用域再把文档解析一遍。
 */
export function scopeFromUnclosedBlocks(
  input: TemplateScopeInput,
  blocks: TemplateBlockNode[],
): TemplateScope {
  let scope = rootScope(input)
  for (const block of blocks) {
    scope = enterBlock(scope, block.kind, block.target, block.bindings)
  }
  return scope
}

/** 根作用域：只放模板变量 */
function rootScope(input: TemplateScopeInput): TemplateScope {
  const scope = scopeOf(null)
  for (const variable of input.variables) {
    scope.symbols.set(variable.name.toLowerCase(), {
      name: variable.name,
      type: variable.type ?? 'unknown',
      label: variable.label,
      properties: variable.properties,
      elementType: variable.elementType,
    })
  }
  return scope
}

/** 进入一个块：建立新的作用域层（含 range 的局部变量与 `.` 指向） */
function enterBlock(
  parent: TemplateScope,
  kind: 'if' | 'range' | 'with',
  target: string | undefined,
  bindings: { index?: string, item?: string },
): TemplateScope {
  const scope = scopeOf(parent, parent.dot)
  if (kind === 'if' || !target) {
    return scope
  }

  const symbol = lookupSymbol(parent, target)

  if (kind === 'with') {
    // `with 对象`：`.` 指向该对象本身
    if (symbol) {
      scope.dot = symbol
    }
    return scope
  }

  // `range 数组`：`.` 指向元素；`$i` / `$v` 是局部变量
  const itemType = symbol?.elementType ?? 'unknown'
  const item: TemplateSymbol = {
    name: bindings.item ?? symbol?.name ?? '.',
    type: itemType,
    properties: itemType === 'object' ? symbol?.properties : undefined,
  }
  scope.dot = item

  if (bindings.index) {
    scope.symbols.set(bindings.index.toLowerCase(), { name: bindings.index, type: 'number' })
  }
  if (bindings.item) {
    scope.symbols.set(bindings.item.toLowerCase(), item)
  }
  return scope
}

/**
 * 查找符号：先本层，再逐层向上（模板的变量是词法作用域）。
 *
 * `target` 允许写成 `device`、`$v`、`device.name` 的链式写法，
 * 这里只看第一段。
 */
export function lookupSymbol(scope: TemplateScope | null, target: string): TemplateSymbol | null {
  const head = target.trim().replace(/^\$/, '').split(/[.\s(]/)[0]
  if (!head) {
    return null
  }
  const key = head.toLowerCase()

  for (let current = scope; current; current = current.parent) {
    const found = current.symbols.get(key)
    if (found) {
      return found
    }
    // 点号取值进入对象后，其属性也是可见符号（`{{with device}}{{.name}}` 之外，
    // 也可能直接写 `name`）
    if (current.dot && current.dot.name.toLowerCase() === key) {
      return current.dot
    }
  }
  return null
}

/** 当前作用域里可见的全部符号（内层优先，同名只留最内层） */
export function scopeSymbols(scope: TemplateScope | null, includeLocals = true): TemplateSymbol[] {
  const result: TemplateSymbol[] = []
  const seen = new Set<string>()

  for (let current = scope; current; current = current.parent) {
    for (const [key, symbol] of current.symbols) {
      if (seen.has(key)) {
        continue
      }
      if (!includeLocals && symbol.name.startsWith('$')) {
        continue
      }
      seen.add(key)
      result.push(symbol)
    }
  }
  return result
}

/** 只取局部变量（`$i` / `$v`） */
export function localSymbols(scope: TemplateScope | null): TemplateSymbol[] {
  return scopeSymbols(scope).filter(symbol => symbol.name.startsWith('$'))
}

/**
 * 解析点号取值该给什么候选。
 *
 * - `{{ .name| }}`（qualifier 为空）→ 当前 `.` 的属性；
 * - `{{ device.| }}`（qualifier 为 device）→ 该变量的属性；
 * - 拿不到属性信息时返回空数组：由调用方决定回退策略（宁可回退到变量列表，
 *   也不要凭空的属性名）。
 */
export function dotCandidates(
  scope: TemplateScope | null,
  qualifier: string,
): TemplateProperty[] {
  if (!qualifier) {
    return scope?.dot?.properties ?? []
  }

  const symbol = lookupSymbol(scope, qualifier)
  if (symbol?.properties?.length) {
    return symbol.properties
  }
  const dot = scope?.dot
  if (dot && dot.name.toLowerCase() === qualifier.toLowerCase()) {
    return dot.properties ?? []
  }
  return []
}
