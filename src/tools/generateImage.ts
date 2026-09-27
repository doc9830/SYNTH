import type { Tool, ToolContext, ToolResult } from './types'

/**
 * generate_image — реальная генерация изображений через API провайдера.
 * Модель выбирается в настройках → «Подключение», а сам механизм
 * (Images API vs chat-эндпоинт) изолирован в providers/openai/images.ts.
 */
export const generateImageTool: Tool = {
  name: 'generate_image',
  description:
    'Генерирует изображение по текстовому описанию и показывает его пользователю прямо в чате. Используй, когда пользователь просит нарисовать, создать картинку, иллюстрацию, логотип, арт. В аргументе prompt дай подробное описание на английском или русском языке.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Подробное описание изображения: что изобразить, стиль, композиция, освещение, детали.',
      },
      size: {
        type: 'string',
        description:
          'Размер изображения, например 1024x1024, 1536x1024 или 1024x1536. Обе стороны кратны 16. Необязателен.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) throw new Error('Пустой prompt: параметр prompt обязателен.')

    const { generateImages } = await import('@/api')
    const model = ctx.settings.image.model
    const result = await generateImages(
      ctx.settings,
      {
        model,
        prompt,
        size: typeof args.size === 'string' && args.size ? args.size : undefined,
      },
      ctx.signal,
    )

    // ВАЖНО: base64 НЕ отправляем обратно модели — раздуёт контекст.
    // Изображение уже показано пользователю в интерфейсе.
    const caption = result.text ? `Комментарий модели: ${result.text}\n\n` : ''
    return {
      content: [
        `${caption}Изображение успешно сгенерировано и уже показано пользователю в чате.`,
        `Модель генерации: ${model}.`,
        `Промпт: ${prompt}`,
        'Не выводи base64 или ссылки на изображение в ответе — просто опиши результат словами.',
      ].join('\n'),
      summary: 'Изображение готово',
      images: result.images,
    }
  },
}
