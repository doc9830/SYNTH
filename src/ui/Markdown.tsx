import { isValidElement, memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { copyText } from '@/lib/clipboard'
import { exportMarkdown, fileNameForBlock } from '@/lib/shareFiles'
import { notify } from '@/lib/toast'
import { blockMatches } from '@/lib/ttsText'
import { cn } from '@/lib/utils'
import { IconCheck, IconCopy, IconShare } from './icons'

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

/** Блок кода с подписью языка, копированием и отправкой файлом. */
function CodeBlock({ language, code, children }: { language: string; code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState(false)
  /** Пустой блок отдавать нечем: файл не создаём, кнопка неактивна. */
  const canShare = code.trim().length > 0

  const onCopy = async () => {
    const ok = await copyText(code)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }

  const onShare = async () => {
    setSharing(true)
    try {
      const result = await exportMarkdown([{ name: fileNameForBlock(language, code), content: code }])
      if (result.method === 'cancelled') return
      if (result.ok) {
        setShared(true)
        window.setTimeout(() => setShared(false), 1600)
      }
      notify(result.message, result.ok ? 'success' : 'error')
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="group relative my-3 overflow-hidden rounded-xl border border-neutral-700/60 bg-[#0f172a]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-700/60 px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] uppercase tracking-wide text-neutral-400">
          {language || 'code'}
        </span>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-neutral-300 transition hover:bg-neutral-700/60 hover:text-white"
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
          <button
            type="button"
            onClick={onShare}
            disabled={!canShare || sharing}
            title={canShare ? 'Поделиться файлом' : 'Блок пустой — отправлять нечего'}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-neutral-300 transition hover:bg-neutral-700/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {shared ? <IconCheck size={13} /> : <IconShare size={13} />}
            {shared ? 'Отправлено' : sharing ? 'Готовлю…' : 'Поделиться файлом'}
          </button>
        </div>
      </div>
      <pre className="chat-md !my-0 !rounded-none !bg-transparent !p-3 text-neutral-100">
        <code>{children}</code>
      </pre>
    </div>
  )
}

/** Пропсы берём «узкими» — так `node` из react-markdown не попадает в DOM. */
interface CodeProps {
  className?: string
  children?: ReactNode
}
interface LinkProps {
  href?: string
  title?: string
  children?: ReactNode
}
interface ImgProps {
  src?: string
  alt?: string
  title?: string
}
interface TableProps {
  children?: ReactNode
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }: CodeProps) => {
    const match = /language-([\w-]+)/.exec(className ?? '')
    const text = extractText(children)
    const isBlock = Boolean(match) || text.includes('\n')
    if (!isBlock) return <code className={className}>{children}</code>
    return (
      <CodeBlock language={match?.[1] ?? ''} code={text}>
        {children}
      </CodeBlock>
    )
  },
  a: ({ href, title, children }: LinkProps) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt, title }: ImgProps) => (
    <img
      src={src}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      className="my-2 max-h-[70vh] w-auto max-w-full rounded-xl border border-neutral-300/60 dark:border-neutral-700/60"
    />
  ),
  table: ({ children }: TableProps) => (
    <div className="my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}

/** Пропс «узкий»: у блока нам нужен только текст и класс от markdown. */
interface BlockProps {
  children?: ReactNode
  className?: string
}

/** Класс подсветки, если этот блок читается прямо сейчас (задача 06). */
function speakingClass(children: ReactNode, className: string | undefined, key: string): string {
  // Точное совпадение редко достижимо (в блоке бывает разметка), поэтому
  // blockMatches сравнивает ещё и по вложению длинного фрагмента.
  return cn(className, blockMatches(extractText(children), key) && 'tts-speaking')
}

/**
 * Тот же набор компонентов, но абзац/заголовок/пункт/цитата, который сейчас
 * озвучивается, получает класс `tts-speaking` — его подсвечивает index.css.
 */
function componentsWithHighlight(key: string): Components {
  return {
    ...components,
    p: ({ children, className }: BlockProps) => (
      <p className={speakingClass(children, className, key)}>{children}</p>
    ),
    h1: ({ children, className }: BlockProps) => (
      <h1 className={speakingClass(children, className, key)}>{children}</h1>
    ),
    h2: ({ children, className }: BlockProps) => (
      <h2 className={speakingClass(children, className, key)}>{children}</h2>
    ),
    h3: ({ children, className }: BlockProps) => (
      <h3 className={speakingClass(children, className, key)}>{children}</h3>
    ),
    h4: ({ children, className }: BlockProps) => (
      <h4 className={speakingClass(children, className, key)}>{children}</h4>
    ),
    h5: ({ children, className }: BlockProps) => (
      <h5 className={speakingClass(children, className, key)}>{children}</h5>
    ),
    h6: ({ children, className }: BlockProps) => (
      <h6 className={speakingClass(children, className, key)}>{children}</h6>
    ),
    li: ({ children, className }: BlockProps) => (
      <li className={speakingClass(children, className, key)}>{children}</li>
    ),
    blockquote: ({ children, className }: BlockProps) => (
      <blockquote className={speakingClass(children, className, key)}>{children}</blockquote>
    ),
  }
}


interface MarkdownProps {
  content: string
  className?: string
  /** Скрывать markdown во время стрима нельзя: рендерим как есть */
  compact?: boolean
  /** Нормализованный текст фрагмента, который читает озвучка (задача 06). */
  highlight?: string | null
}

/**
 * Markdown-рендер ответа модели: GFM + подсветка кода.
 * memo — чтобы длинные сообщения не перерисовывались при каждом кадре стрима.
 */
export const Markdown = memo(function Markdown({ content, className, compact, highlight }: MarkdownProps) {
  // Набор компонентов меняем только при смене фрагмента: подсветка идёт по
  // абзацам, а не по словам, так что перерисовок мало.
  const rendered = useMemo(
    () => (highlight ? componentsWithHighlight(highlight) : components),
    [highlight],
  )
  return (
    <div className={cn('chat-md text-neutral-800 dark:text-neutral-100', compact && 'text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={rendered}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
