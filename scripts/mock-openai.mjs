import { createServer } from 'node:http'

/**
 * Мок OpenAI-совместимого провайдера: нужен, чтобы проверить,
 * как приложение подтягивает список моделей и рисует селекторы.
 * Запуск: node scripts/mock-openai.mjs  (порт 8799)
 */

const MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o4-mini',
  'claude-sonnet-4.5',
  'gemini-2.5-flash',
  'deepseek-chat',
  'deepseek-reasoner',
  'llama-3.3-70b-versatile',
  'mistral-large-latest',
  'qwen3-235b-a22b',
  'gpt-image-1',
  'dall-e-3',
  'flux-1.1-pro',
  'gemini-2.5-flash-image',
  'stable-diffusion-3.5-large',
  'ideogram-v3',
]

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '600',
}

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, ...CORS })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    console.log('[mock] GET /v1/models')
    send(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    console.log('[mock] POST /v1/chat/completions')
    const body = await readJson(req)
    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        ...CORS,
      })
      const chunk = (delta) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta }] })}\n\n`

      // Сначала «мысли» (reasoning_content), затем текст ответа с блоком кода —
      // так можно посмотреть живые фазы: «Думаю…» → «Пишу код…» → «Отвечаю…».
      const steps = [
        { reasoning_content: 'Сначала разберу, что просит пользователь. ' },
        { reasoning_content: 'Нужен короткий пример кода — оформлю блоком TypeScript. ' },
        { reasoning_content: 'Проверю, что стриминг и печать работают по мере генерации.' },
        { content: 'Привет! Это ответ мок-сервера SYNTH.\n\n' },
        { content: 'Пример функции debounce:\n\n```ts\n' },
        { content: 'export function debounce<T extends (...args: never[]) => void>(fn: T, delay = 300) {\n' },
        { content: '  let timer: number | undefined\n  return (...args: Parameters<T>) => {\n' },
        { content: '    window.clearTimeout(timer)\n    timer = window.setTimeout(() => fn(...args), delay)\n' },
        { content: '  }\n}\n```\n\n' },
        { content: 'Текст печатается по мере генерации, а мысли видны под катом.' },
      ]

      let index = 0
      const timer = setInterval(() => {
        if (index >= steps.length) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.write(chunk(steps[index]))
        index += 1
      }, 320)

      req.on('close', () => clearInterval(timer))
      return
    }
    send(res, 200, {
      id: 'x',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
    console.log('[mock] POST /v1/images/generations')
    await readJson(req)
    send(res, 200, { created: Date.now(), data: [{ b64_json: PNG, revised_prompt: 'mock' }] })
    return
  }

  send(res, 404, { error: { message: `Нет эндпоинта ${req.method} ${url.pathname}` } })
})

function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

server.listen(8799, '127.0.0.1', () => console.log('mock-openai на http://127.0.0.1:8799'))
