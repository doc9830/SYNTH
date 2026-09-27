import type { Settings } from '@/lib/settings'
import type { WireTool } from '@/providers/openai/types'
import { generateImageTool } from './generateImage'
import { readUrlTool } from './readUrl'
import type { Tool } from './types'
import { webSearchTool } from './webSearch'

export * from './types'

/** Набор инструментов, доступных модели при текущих настройках. */
export function buildTools(settings: Settings): Tool[] {
  const tools: Tool[] = []
  if (settings.search.enabled) tools.push(webSearchTool)
  // read_url живёт в той же вкладке настроек, что и поиск: это «работа с вебом»
  if (settings.search.enabled && settings.search.readPages) tools.push(readUrlTool)
  if (settings.image.enabled) tools.push(generateImageTool)
  return tools
}

export function toolMap(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

/** Превращает инструменты в формат tools для OpenAI-совместимого запроса. */
export function toWireTools(tools: Tool[]): WireTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  }))
}

/** Человекочитаемые подписи для UI tool activity (без сырых tool calls). */
export const TOOL_LABELS: Record<
  string,
  { icon: string; running: string; done: string; failed: string }
> = {
  web_search: {
    icon: '🌐',
    running: 'Ищу в интернете…',
    done: 'Поиск завершён',
    failed: 'Не удалось выполнить поиск',
  },
  read_url: {
    icon: '📄',
    running: 'Открываю страницу по ссылке…',
    done: 'Страница прочитана',
    failed: 'Не удалось прочитать страницу',
  },
  generate_image: {
    icon: '🎨',
    running: 'Генерирую изображение…',
    done: 'Изображение готово',
    failed: 'Не удалось сгенерировать изображение',
  },
}

export function toolLabel(name: string): { icon: string; running: string; done: string; failed: string } {
  return (
    TOOL_LABELS[name] ?? {
      icon: '🧩',
      running: `Выполняю ${name}…`,
      done: `${name} завершён`,
      failed: `${name}: ошибка`,
    }
  )
}
