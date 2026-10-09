import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 合并类名（shadcn 的约定）：
 * `clsx` 处理条件类，`twMerge` 让后面的同名类覆盖前面的 ——
 * 于是调用方可以用 `class="w-full"` 覆盖组件内置的 `w-40`，不需要 `!important`。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
