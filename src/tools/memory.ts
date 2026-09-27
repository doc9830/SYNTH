import { remember, searchMemory, similarity, useMemory } from '@/lib/memory'
import type { MemoryKind } from '@/types'
import type { Tool, ToolResult } from './types'

/**
 * Инструменты долговременной памяти.
 * Модель сама решает, когда сохранить факт (`remember`) и когда поискать
 * по памяти глубже, чем даёт автоматический блок контекста (`recall`).
 * Забывание (`forget`) намеренно осторожное: удаляем только близкие записи.
 */

const KINDS: MemoryKind[] = ['fact', 'preference', 'project', 'instruction', 'note']
/** Порог похожести для удаления: ниже — не трогаем, чтобы не снести лишнее. */
const FORGET_THRESHOLD = 0.5

export const rememberTool: Tool = {
  name: 'remember',
  description:
    'Сохраняет в долговременную память один устойчивый факт о пользователе (имя, город, язык, стек, предпочтения к ответам, важные особенности проектов). Вызывай, когда пользователь прямо просит запомнить или когда факт явно пригодится в будущих беседах. Не сохраняй секреты (ключи, пароли), разовые задачи и содержание своих ответов.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Один факт одной короткой фразой от третьего лица: «пользователь живёт в Казани».',
      },
      kind: {
        type: 'string',
        enum: KINDS,
        description: 'Вид записи: fact (факт), preference (предпочтение), project (проект), instruction (указание), note (заметка). Необязателен.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'До 4 коротких тегов для поиска, например ["город", "погода"]. Необязательно.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const text = String(args.text ?? '').trim()
    if (!text) throw new Error('Параметр text обязателен.')
    const kind = KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : undefined
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : []

    const entry = await remember(text, { kind, tags, source: 'tool' })
    if (!entry) {
      return {
        content:
          'Запись не сохранена: текст слишком короткий либо похож на секрет (ключи, пароли и номера карт память не хранит).',
        summary: 'Память: не сохранено',
      }
    }
    return {
      content: `Сохранено в память: «${entry.text}». Записей в памяти: ${useMemory.getState().entries.length}.`,
      summary: 'Запомнил',
    }
  },
}

export const recallTool: Tool = {
  name: 'recall',
  description:
    'Ищет по долговременной памяти пользователя. Автоматический блок памяти уже подмешивается в контекст, поэтому вызывай этот инструмент, только если нужного факта там нет, а вопрос пользователя явно требует подробностей о нём (имена, предпочтения, проекты, прошлые договорённости).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Что именно нужно вспомнить: ключевые слова или вопрос.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const query = String(args.query ?? '').trim()
    const total = useMemory.getState().entries.length
    if (!total) {
      return { content: 'Память пуста: записей о пользователе пока нет.', summary: 'Память пуста' }
    }
    const found = searchMemory(query || '*', 8)
    if (!found.length) {
      return {
        content: `По запросу «${query}» в памяти ничего не найдено. Всего записей: ${total}.`,
        summary: 'В памяти нет',
      }
    }
    return {
      content: [
        `Найдено записей: ${found.length} из ${total}:`,
        ...found.map((e) => `- ${e.text}${e.pinned ? ' (закреплено)' : ''}`),
      ].join('\n'),
      summary: `Вспомнил ${found.length} записей`,
    }
  },
}

export const forgetTool: Tool = {
  name: 'forget',
  description:
    'Удаляет из долговременной памяти запись о пользователе, которую он просит забыть. Вызывай только по прямой просьбе («забудь, что…»). Удаляются только записи, близкие по смыслу к указанному тексту.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Факт или ключевые слова, которые нужно удалить из памяти.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const text = String(args.text ?? '').trim()
    if (!text) throw new Error('Параметр text обязателен.')
    const entries = useMemory.getState().entries
    const targets = entries.filter((e) => similarity(e.text, text) >= FORGET_THRESHOLD)
    if (!targets.length) {
      return {
        content: `Совпадений с «${text}» в памяти нет — удалять нечего.`,
        summary: 'Нечего забывать',
      }
    }
    for (const entry of targets) await useMemory.getState().remove(entry.id)
    return {
      content: [
        `Из памяти удалено записей: ${targets.length}.`,
        ...targets.map((e) => `- ${e.text}`),
        `Осталось записей: ${useMemory.getState().entries.length}.`,
      ].join('\n'),
      summary: `Забыл ${targets.length} записей`,
    }
  },
}
