/**
 * Проверка стора стрима: кадры не должны попадать в список сообщений.
 *
 * Смысл: React перерисовывает подписчика zustand ровно тогда, когда меняется
 * результат его селектора (Object.is). Самое дорогое подписанное значение в
 * приложении — `conversations` (сайдбар, шапка, список сообщений, счётчик
 * контекста). Если за ход ссылка `conversations` не менялась, эти компоненты
 * не перерисовались ни разу.
 *
 * Запуск: npm run checks
 */
import { useConversations } from '@/lib/conversations'
import {
  clearStreamDraft,
  publishStreamDraft,
  selectStreamPatch,
  useStreamDraft,
} from '@/lib/streamDraft'
import type { ChatMessage, Conversation } from '@/types'
import { check, finish } from './harness'

const FRAMES = 250 // столько кадров даёт ответ примерно на 500 токенов

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, createdAt: 1, content, status: 'complete' }
}

function conversation(id: string, count: number, updatedAt: number): Conversation {
  const messages: ChatMessage[] = []
  for (let i = 0; i < count; i++) {
    messages.push(message(`${id}-m${i}`, i % 2 ? 'assistant' : 'user', `сообщение ${i}`))
  }
  messages.push({
    id: `${id}-stream`,
    role: 'assistant',
    createdAt: 2,
    content: '',
    status: 'streaming',
  })
  return {
    id,
    title: `чат ${id}`,
    createdAt: 0,
    updatedAt,
    pinned: false,
    model: 'deepseek-flash',
    messages,
  }
}

/** Порядок чатов в сайдбаре (копия ORDER из conversations.ts — для метрики «до»). */
const ORDER = (a: Conversation, b: Conversation): number => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return b.updatedAt - a.updatedAt
}

/** Прежний путь: каждый кадр — новый массив сообщений, новый чат и пересортировка списка. */
function legacyFrame(conversationId: string, messageId: string, content: string): void {
  useConversations.setState((s) => ({
    conversations: s.conversations
      .map((c) =>
        c.id === conversationId
          ? {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
            }
          : c,
      )
      .sort(ORDER),
  }))
}

/** Нотификации стора = кандидаты на перерисовку подписчиков. */
function countNotifications(frames: number): { notifications: number; identityChanges: number } {
  const before = useConversations.getState().conversations
  let notifications = 0
  let identityChanges = 0
  const unsubscribe = useConversations.subscribe((s) => {
    notifications++
    if (s.conversations !== before) identityChanges++
  })
  try {
    for (let i = 0; i < frames; i++) legacyFrame('conv-a', 'conv-a-stream', `текст ${i}`)
  } finally {
    unsubscribe()
  }
  return { notifications, identityChanges }
}

/* ───────────────────────── подготовка стора ───────────────────────── */

const longChat = conversation('conv-a', 120, 5_000)
const otherChat = conversation('conv-b', 8, 4_000)
useConversations.setState({ conversations: [longChat, otherChat], activeId: 'conv-a', loaded: true })

const baseline = useConversations.getState().conversations
const baselineChat = baseline[0]
const baselineUpdatedAt = baselineChat.updatedAt

/* ─────────────── 1. кадры стрима не трогают список чатов ─────────────── */

let streamNotifications = 0
let streamIdentityChanges = 0
const unsubscribe = useConversations.subscribe((s) => {
  streamNotifications++
  if (s.conversations !== baseline) streamIdentityChanges++
})

let published = 0
for (let i = 0; i < FRAMES; i++) {
  publishStreamDraft('conv-a', 'conv-a-stream', {
    content: `текст ${i}`,
    reasoning: 'думаю',
    reasoningMs: i,
    toolCalls: [],
    status: 'streaming',
  })
  // ровно так состояние и спрашивают подписчики (сайдбар, шапка, блок сообщения)
  const patch = selectStreamPatch('conv-a-stream')(useStreamDraft.getState())
  if (patch && patch.content === `текст ${i}`) published++
}
unsubscribe()

const after = useConversations.getState().conversations

check(`за ${FRAMES} кадров стрима стор чатов уведомлён 0 раз`, streamNotifications === 0)
check('ссылка conversations не менялась за стрим', streamIdentityChanges === 0)
check('ссылка активного чата не менялась за стрим', after[0] === baselineChat)
check('updatedAt чата не менялся (значит, и сортировки не было)', after[0].updatedAt === baselineUpdatedAt)
check('все кадры дошли до подписчика сообщения', published === FRAMES)
check('в стор чатов по-прежнему пустой стримящийся блок', after[0].messages.at(-1)?.content === '')

/* ─────────────── 2. подписка на кадр: только своё сообщение ─────────────── */

const patchA = selectStreamPatch('conv-a-stream')(useStreamDraft.getState())
const patchOther = selectStreamPatch('conv-b-m1')(useStreamDraft.getState())
check('патч есть у стримящегося сообщения', Boolean(patchA?.content))
check('у чужого сообщения патча нет (null)', patchOther === null)
check(
  'null стабилен между вызовами (нет лишних рендеров)',
  patchOther === selectStreamPatch('conv-b-m1')(useStreamDraft.getState()),
)
check(
  'повторный запрос того же состояния даёт ту же ссылку',
  selectStreamPatch('conv-a-stream')(useStreamDraft.getState()) === patchA,
)

publishStreamDraft('conv-a', 'conv-a-stream', { content: 'новый кадр', status: 'streaming' })
const patchNew = selectStreamPatch('conv-a-stream')(useStreamDraft.getState())
check('новый кадр — новая ссылка (рендер только одного блока)', patchNew !== patchA)

/* ─────────────── 3. слияние кадра в сообщение (как в MessageItem) ─────────────── */

const merged: ChatMessage = { ...after[0].messages.at(-1)!, ...patchNew }
check('слияние кадра даёт текст', merged.content === 'новый кадр')
check(
  'слияние кадра не теряет id и роль сообщения',
  merged.id === 'conv-a-stream' && merged.role === 'assistant',
)

/* ─────────────── 4. очистка черновика ─────────────── */

clearStreamDraft('чужой-id')
check('чужой id черновик не очищает', useStreamDraft.getState().draft !== null)
clearStreamDraft('conv-a-stream')
check('свой id черновик очищает', useStreamDraft.getState().draft === null)
clearStreamDraft()
check('повторная очистка безопасна', useStreamDraft.getState().draft === null)

/* ─────────────── 5. метрика «до»: прежний путь ─────────────── */

const legacy = countNotifications(FRAMES)
check(
  `метрика «до»: ${FRAMES} кадров → ${legacy.notifications} уведомлений стора (реплика прежнего пути)`,
  legacy.notifications === FRAMES && legacy.identityChanges === FRAMES,
)

finish()
