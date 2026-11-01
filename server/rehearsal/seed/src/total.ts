export interface Line { price: number; qty: number }

/** Cart total. BUG: the discount is ignored. */
export function cartTotal(lines: Line[], discountPercent = 0): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);
}
