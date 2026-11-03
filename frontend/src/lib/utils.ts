import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并类名（shadcn 的约定）： `clsx` 处理条件类 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
