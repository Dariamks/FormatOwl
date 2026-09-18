import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function bytes(value: number) {
  if (!value) return '0 B';
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][power]}`;
}
