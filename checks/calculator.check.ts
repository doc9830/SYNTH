/**
 * Проверка калькулятора: арифметика, приоритеты, функции и понятные ошибки.
 * Запуск: npm run checks
 */
import { evaluateExpression } from '@/tools/calculator'
import { check, finish } from './harness'

const cases: Array<[string, number]> = [
  ['2+2', 4],
  ['2 + 3 * 4', 14],
  ['(2 + 3) * 4', 20],
  ['-2^2', -4],
  ['2^-3', 0.125],
  ['2^3^2', 512],
  ['10 % 3', 1],
  ['sqrt(16) + abs(-5)', 9],
  ['max(1, 2, 3)', 3],
  ['min(1, 2, 3) * 2', 2],
  ['1 + max(2, 3)', 4],
  ['2 * (3 + 4) + 1', 15],
  ['round(3.7) + floor(3.7) + ceil(3.1)', 11],
  ['3,5 + 1', 4.5],
  ['2(3+4)', 14],
  ['1250 * 0.2', 250],
  ['pi', Math.PI],
  ['1e3 / 4', 250],
  ['-(-5)', 5],
]

for (const [expr, expected] of cases) {
  let ok = false
  try {
    ok = Math.abs(evaluateExpression(expr) - expected) < 1e-9
  } catch {
    ok = false
  }
  check(`${expr} = ${expected}`, ok)
}

// Ошибки должны быть понятными фразами, а не падением со стеком.
const bad: Array<[string, RegExp]> = [
  ['', /Пустое выражение/],
  ['2 +', /Не хватает операндов/],
  ['(1+2', /Не закрыта скобка/],
  ['1/0', /Деление на ноль/],
  ['1 + unknownfn(2)', /Неизвестное имя/],
  ['5 abc', /Неизвестное имя/],
  ['sqrt()', /без аргументов/],
]

for (const [expr, pattern] of bad) {
  let message = ''
  try {
    evaluateExpression(expr)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  check(`«${expr}» → ${pattern.source}`, pattern.test(message))
}

finish()
