import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImageAttachment } from '@/types'
import { useActiveConversation, useConversations } from '@/lib/conversations'
import { minimizeApp, onAndroidBack } from '@/lib/nativeShell'
import { getReadiness } from '@/lib/readiness'
import { isConfigured, useSettings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { useUpdateStore } from '@/lib/updateStore'
import { useAppearance } from '@/lib/useAppearance'
import { useChat } from '@/lib/useChat'
import { ChatHeader } from '@/ui/ChatHeader'
import { Composer } from '@/ui/Composer'
import { DebugConsole } from '@/ui/DebugConsole'
import { MessageList } from '@/ui/MessageList'
import { SettingsDialog } from '@/ui/SettingsDialog'
import { SetupDialog } from '@/ui/SetupDialog'
import { Sidebar } from '@/ui/Sidebar'
import { Toaster } from '@/ui/Toaster'
import { UpdateDialog } from '@/ui/UpdateDialog'
import { WelcomeScreen } from '@/ui/WelcomeScreen'

/**
 * Корневой компонент приложения.
 * Собирает вместе сайдбар, шапку, ленту сообщений и композер,
 * а также онбординг (регистрация подключения), настройки и диагностику.
 */
export default function App() {
  useAppearance()

  const settings = useSettings((s) => s.settings)
  const loaded = useConversations((s) => s.loaded)
  const load = useConversations((s) => s.load)
  const conversation = useActiveConversation()
  const { send, stop, regenerate, editAndResend, removeMessage, isStreaming } = useChat()

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  const readiness = useMemo(() => getReadiness(settings), [settings])
  const blockingIssue = readiness.issues.find((i) => i.severity === 'error')
  /** Минимум для общения: адрес API + ключ + модель (см. isConfigured). */
  const configured = useMemo(() => isConfigured(settings), [settings])

  const toolsHint = useMemo(() => {
    const hints: string[] = []
    if (settings.search.enabled) hints.push('web_search')
    if (settings.image.enabled) hints.push('generate_image')
    return hints
  }, [settings.search.enabled, settings.image.enabled])

  useEffect(() => {
    void load()
  }, [load])

  // Тихая проверка обновлений при запуске (не чаще раза в 6 часов,
  // «пропущенные» версии не предлагаются повторно).
  const checkUpdates = useUpdateStore((s) => s.check)
  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => void checkUpdates({ auto: true }), 2000)
    return () => window.clearTimeout(timer)
  }, [loaded, checkUpdates])

  // Первый запуск: подключение не настроено и мастер ещё не проходили — открываем его.
  const prompted = useRef(false)
  useEffect(() => {
    if (prompted.current || !loaded) return
    prompted.current = true
    const current = useSettings.getState().settings
    if (!current.setupDone && !isConfigured(current)) setSetupOpen(true)
  }, [loaded])

  // модальные окна прячут мобильный сайдбар
  useEffect(() => {
    if (settingsOpen || debugOpen || setupOpen) setSidebarOpen(false)
  }, [settingsOpen, debugOpen, setupOpen])

  // модальные окна взаимоисключающие: открывая одно, закрываем остальные
  const openSettings = () => {
    setDebugOpen(false)
    setSetupOpen(false)
    setSettingsOpen(true)
  }

  /** Мастер подключения: кнопка на стартовом экране и вход из настроек. */
  const openSetup = () => {
    setDebugOpen(false)
    setSettingsOpen(false)
    setSetupOpen(true)
  }

  const openDebug = () => {
    setSettingsOpen(false)
    setSetupOpen(false)
    setDebugOpen(true)
  }

  // Аппаратная кнопка «Назад» в APK: сначала закрываем открытые панели,
  // и только когда закрывать нечего — сворачиваем приложение.
  useEffect(() => {
    return onAndroidBack(() => {
      if (setupOpen) setSetupOpen(false)
      else if (settingsOpen) setSettingsOpen(false)
      else if (debugOpen) setDebugOpen(false)
      else if (sidebarOpen) setSidebarOpen(false)
      else void minimizeApp()
    })
  }, [setupOpen, settingsOpen, debugOpen, sidebarOpen])

  const handleSend = (text: string, attachments: ImageAttachment[]) => {
    if (!readiness.canChat) {
      openSetup()
      notify(blockingIssue?.message ?? 'Сначала настройте подключение к API.', 'error')
      return
    }
    void send(text, attachments)
  }

  const handleSuggestion = (text: string) => {
    if (!readiness.canChat) {
      openSetup()
      notify(blockingIssue?.message ?? 'Сначала настройте подключение к API.', 'error')
      return
    }
    void send(text)
  }

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={openSettings}
        onOpenDebug={openDebug}
        onOpenSetup={openSetup}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          conversation={conversation}
          settings={settings}
          readiness={readiness}
          busy={isStreaming}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenSettings={openSettings}
          onOpenDebug={openDebug}
        />

        {configured ? (
          <MessageList
            conversation={conversation}
            busy={isStreaming}
            onRegenerate={() => void regenerate()}
            onEdit={(messageId, text) => void editAndResend(messageId, text)}
            onDelete={removeMessage}
            onSuggestion={handleSuggestion}
            onOpenSettings={openSettings}
          />
        ) : (
          <WelcomeScreen onSetup={openSetup} onOpenSettings={openSettings} />
        )}

        <Composer
          conversationId={conversation?.id ?? null}
          busy={isStreaming}
          canSend={readiness.canChat}
          disabledReason={
            blockingIssue ? `${blockingIssue.message} ${blockingIssue.fix}` : undefined
          }
          toolsHint={toolsHint}
          sendOnEnter={settings.ui.sendOnEnter}
          model={conversation?.model || settings.model}
          onSend={handleSend}
          onStop={stop}
        />
      </div>

      <SetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        firstRun={!settings.setupDone}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenDebug={openDebug}
      />
      <DebugConsole open={debugOpen} onClose={() => setDebugOpen(false)} />
      <UpdateDialog />
      <Toaster />
    </div>
  )
}
