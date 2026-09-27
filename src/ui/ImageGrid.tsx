import { useState } from 'react'
import { copyImage } from '@/lib/clipboard'
import { saveImageFile } from '@/lib/files'
import { notify } from '@/lib/toast'
import { IconCheck, IconDownload, IconImage } from './icons'

function extOf(dataUrl: string): string {
  const mime = /^data:image\/(\w+)[;,]/i.exec(dataUrl)?.[1]?.toLowerCase()
  if (!mime) return 'png'
  return mime === 'jpeg' ? 'jpg' : mime
}

/** Галерея сгенерированных изображений (data URL) с сохранением и копированием. */
export function ImageGrid({ images, alt = 'Сгенерированное изображение' }: { images: string[]; alt?: string }) {
  const [copied, setCopied] = useState<number | null>(null)

  if (!images.length) return null

  const onCopy = async (dataUrl: string, index: number) => {
    const ok = await copyImage(dataUrl)
    if (ok) {
      setCopied(index)
      window.setTimeout(() => setCopied(null), 1600)
      notify('Изображение скопировано в буфер обмена', 'success')
    } else {
      notify('Браузер не поддерживает копирование изображений — используйте «Скачать».', 'error')
    }
  }

  return (
    <div className="my-2 flex flex-wrap gap-3">
      {images.map((src, i) => (
        <figure
          key={`${src.slice(-24)}-${i}`}
          className="group relative overflow-hidden rounded-xl border border-neutral-300/70 dark:border-neutral-700/70"
        >
          <img
            src={src}
            alt={`${alt} ${i + 1}`}
            loading="lazy"
            className="max-h-[70vh] w-auto max-w-full bg-neutral-100 dark:bg-neutral-900"
          />
          <figcaption className="absolute right-2 bottom-2 flex gap-1.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={() => onCopy(src, i)}
              className="flex items-center gap-1 rounded-lg bg-neutral-900/80 px-2 py-1 text-xs text-white backdrop-blur transition hover:bg-neutral-900"
            >
              {copied === i ? <IconCheck size={13} /> : <IconImage size={13} />}
              {copied === i ? 'Скопировано' : 'Копировать'}
            </button>
            <button
              type="button"
              onClick={() => {
                void saveImageFile(src, `image-${Date.now()}-${i + 1}.${extOf(src)}`).then((result) =>
                  notify(result.message, result.ok ? 'success' : 'error'),
                )
              }}
              className="flex items-center gap-1 rounded-lg bg-neutral-900/80 px-2 py-1 text-xs text-white backdrop-blur transition hover:bg-neutral-900"
            >
              <IconDownload size={13} />
              Скачать
            </button>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
