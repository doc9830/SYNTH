import type { Tool, ToolResult } from './types'

/**
 * Калькулятор. Модели считают в уме плохо (особенно цепочки и проценты),
 * поэтому точную арифметику отдаём детерминированному вычислению.
 * Реализация — сортировочная станция (shunting-yard) + стековая машина:
 * eval/Function не используются, выражение разбирается вручную.
 *
 * Поддержка: + - * / % ^, скобки, унарный минус, функции, константы pi/e/tau,
 * десятичная запятая («3,5») и привычные знаки ×/÷/х.
 */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'op'; v: string }
  | { t: 'fn'; v: string }
  /** Только в RPN: сколько аргументов было у функции (для min/max и проверок) */
  | { t: 'argc'; v: number }
  | { t: '(' }
  | { t: ')' }
  | { t: ',' }

const FUNCTIONS: Record<string, { arity: number | 'variadic'; fn: (...a: number[]) => number }> = {
  sqrt: { arity: 1, fn: Math.sqrt },
  abs: { arity: 1, fn: Math.abs },
  round: { arity: 1, fn: Math.round },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 },
  exp: { arity: 1, fn: Math.exp },
  min: { arity: 'variadic', fn: (...a: number[]) => Math.min(...a) },
  max: { arity: 'variadic', fn: (...a: number[]) => Math.max(...a) },
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 }

/** Приоритеты операторов: больше число — раньше считается. */
const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, u: 3, '^': 4 }
/** Правоассоциативные операторы (2^3^2 = 2^(3^2)). */
const RIGHT_ASSOC = new Set(['^', 'u'])

function lex(input: string): Tok[] {
  // десятичная запятая, «умножить/разделить» из клавиатуры телефона
  const src = input.replace(/(\d),(\d)/g, '$1.$2').replace(/[×х]/gi, '*').replace(/÷/g, '/')
  const out: Tok[] = []
  let i = 0

  const prev = (): Tok | undefined => out[out.length - 1]
  const isValueEnd = (): boolean => {
    const p = prev()
    return Boolean(p && (p.t === 'num' || p.t === ')' ))
  }

  while (i < src.length) {
    const ch = src[i]

    if (/\s/.test(ch)) {
      i += 1
      continue
    }

    if (/[0-9.]/.test(ch)) {
      let num = ''
      while (i < src.length && /[0-9._]/.test(src[i])) {
        if (src[i] !== '_') num += src[i]
        i += 1
      }
      if (i < src.length && /[eE]/.test(src[i]) && /[0-9+-]/.test(src[i + 1] ?? '')) {
        num += 'e'
        i += 1
        if (/[+-]/.test(src[i])) {
          num += src[i]
          i += 1
        }
        while (i < src.length && /[0-9]/.test(src[i])) {
          num += src[i]
          i += 1
        }
      }
      const value = Number(num)
      if (!Number.isFinite(value)) throw new Error(`Не удалось разобрать число «${num}».`)
      out.push({ t: 'num', v: value })
      continue
    }

    if (/[a-zA-Zа-яА-Я]/.test(ch)) {
      let name = ''
      while (i < src.length && /[a-zA-Zа-яА-Я0-9_]/.test(src[i])) {
        name += src[i]
        i += 1
      }
      const lower = name.toLowerCase()
      if (FUNCTIONS[lower]) {
        out.push({ t: 'fn', v: lower })
        continue
      }
      if (lower in CONSTANTS) {
        // константа — сразу значение; между «2pi» и «2*pi» ставим умножение
        if (isValueEnd()) out.push({ t: 'op', v: '*' })
        out.push({ t: 'num', v: CONSTANTS[lower] })
        continue
      }
      throw new Error(`Неизвестное имя «${name}».`)
    }

    if (ch === '(') {
      // «2(3+4)» и «2sqrt(9)» — неявное умножение
      if (isValueEnd()) out.push({ t: 'op', v: '*' })
      out.push({ t: '(' })
      i += 1
      continue
    }
    if (ch === ')') {
      out.push({ t: ')' })
      i += 1
      continue
    }
    if (ch === ',') {
      out.push({ t: ',' })
      i += 1
      continue
    }

    if ('+-*/%^'.includes(ch)) {
      const unary = (ch === '-' || ch === '+') && !isValueEnd()
      // унарный плюс ничего не меняет — просто пропускаем знак
      if (!(unary && ch === '+')) out.push(unary ? { t: 'op', v: 'u' } : { t: 'op', v: ch })
      i += 1
      continue
    }

    throw new Error(`Недопустимый символ «${ch}». Разрешены цифры, + - * / % ^, скобки и функции.`)
  }
  return out
}

/** Выражение → RPN (обратная польская запись). */
function toRpn(tokens: Tok[]): Tok[] {
  const out: Tok[] = []
  const stack: Tok[] = []
  // счётчики аргументов для каждого незакрытого «(» и флаг «внутри были операнды»
  const argCounts: number[] = []
  const hasOperand: boolean[] = []

  for (const token of tokens) {
    if (token.t === 'num' || token.t === 'argc') {
      if (token.t === 'num' && hasOperand.length) hasOperand[hasOperand.length - 1] = true
      out.push(token)
      continue
    }
    if (token.t === 'fn') {
      stack.push(token)
      continue
    }
    if (token.t === ',') {
      while (stack.length && stack[stack.length - 1].t !== '(') out.push(stack.pop() as Tok)
      if (!argCounts.length) throw new Error('Запятая вне вызова функции.')
      argCounts[argCounts.length - 1] += 1
      continue
    }
    if (token.t === 'op') {
      // префиксный минус ничего не выталкивает: его операнд ещё не прочитан
      if (token.v === 'u') {
        stack.push(token)
        continue
      }
      const prec = PRECEDENCE[token.v] ?? 0
      while (stack.length) {
        const top = stack[stack.length - 1]
        if (top.t !== 'op') break
        const topPrec = PRECEDENCE[top.v] ?? 0
        const rightAssoc = RIGHT_ASSOC.has(token.v)
        if (rightAssoc ? topPrec > prec : topPrec >= prec) out.push(stack.pop() as Tok)
        else break
      }
      stack.push(token)
      continue
    }
    if (token.t === '(') {
      stack.push(token)
      argCounts.push(0)
      hasOperand.push(false)
      continue
    }
    // ')'
    let found = false
    while (stack.length) {
      const top = stack.pop() as Tok
      if (top.t === '(') {
        found = true
        break
      }
      out.push(top)
    }
    if (!found) throw new Error('Лишняя закрывающая скобка.')
    const commas = argCounts.pop() ?? 0
    const hadOperand = hasOperand.pop() ?? false
    const next = stack[stack.length - 1]
    if (next?.t === 'fn') {
      // пустой вызов «fn()» — ноль аргументов, иначе число запятых + 1
      out.push({ t: 'argc', v: hadOperand ? commas + 1 : 0 })
      out.push(stack.pop() as Tok)
    } else if (hasOperand.length) {
      // результат скобки — это операнд для внешнего уровня: 2*(3+4), max((1+2), 3)
      hasOperand[hasOperand.length - 1] = true
    }
  }

  while (stack.length) {
    const top = stack.pop() as Tok
    if (top.t === '(') throw new Error('Не закрыта скобка.')
    out.push(top)
  }
  return out
}

function applyOperator(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      if (b === 0) throw new Error('Деление на ноль.')
      return a / b
    case '%':
      if (b === 0) throw new Error('Остаток от деления на ноль.')
      return a % b
    case '^':
      return a ** b
    default:
      throw new Error(`Неизвестная операция «${op}».`)
  }
}

function evalRpn(rpn: Tok[]): number {
  const stack: number[] = []
  // счётчики аргументов, пришедшие перед функцией
  const counts: number[] = []

  for (const token of rpn) {
    if (token.t === 'argc') {
      counts.push(token.v)
      continue
    }
    if (token.t === 'num') {
      stack.push(token.v)
      continue
    }
    if (token.t === 'op') {
      if (token.v === 'u') {
        const value = stack.pop()
        if (value === undefined) throw new Error('Неполное выражение после минуса.')
        stack.push(-value)
        continue
      }
      const b = stack.pop()
      const a = stack.pop()
      if (a === undefined || b === undefined) throw new Error('Не хватает операндов в выражении.')
      stack.push(applyOperator(token.v, a, b))
      continue
    }
    if (token.t === 'fn') {
      const spec = FUNCTIONS[token.v]
      const arity = counts.pop() ?? (spec.arity === 'variadic' ? 1 : spec.arity)
      if (arity === 0) throw new Error(`Функция ${token.v} вызвана без аргументов.`)
      if (spec.arity !== 'variadic' && arity !== spec.arity) {
        throw new Error(`Функция ${token.v} ждёт ${spec.arity} аргумент(ов), получено ${arity}.`)
      }
      const args = stack.splice(stack.length - arity, arity)
      if (args.length !== arity) throw new Error(`Функция ${token.v}: мало аргументов.`)
      stack.push(spec.fn(...args))
      continue
    }
    throw new Error('Некорректное выражение.')
  }
  if (stack.length !== 1) throw new Error('Некорректное выражение: лишние операнды.')
  return stack[0]
}

/** Публичная точка входа: строка → число (бросает Error с понятным текстом). */
export function evaluateExpression(expression: string): number {
  const trimmed = expression.trim()
  if (!trimmed) throw new Error('Пустое выражение.')
  if (trimmed.length > 500) throw new Error('Выражение слишком длинное (максимум 500 символов).')
  const result = evalRpn(toRpn(lex(trimmed)))
  if (!Number.isFinite(result)) throw new Error('Результат не является конечным числом.')
  return result
}

/** Красивое число: разделители тысяч, без хвостовых нулей. */
function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toLocaleString('ru-RU')
  return Number(value.toPrecision(12)).toLocaleString('ru-RU', { maximumFractionDigits: 12 })
}

export const calculatorTool: Tool = {
  name: 'calculator',
  description:
    'Точный калькулятор. Используй его для любых вычислений, процентов, степеней и корней вместо счёта в уме. Поддерживает + - * / % ^, скобки, функции sqrt, abs, round, floor, ceil, min, max, ln, log, exp, sin, cos, tan и константы pi, e. Например: "(1250 * 0.2) / 3 + sqrt(16)".',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Математическое выражение для вычисления.',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const expression = String(args.expression ?? '').trim()
    if (!expression) throw new Error('Параметр expression обязателен.')
    const value = evaluateExpression(expression)
    return {
      content: `${expression} = ${formatNumber(value)}`,
      summary: `Посчитал: ${formatNumber(value)}`,
    }
  },
}
