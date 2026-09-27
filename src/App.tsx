import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImageAttachment } from '@/types'
import { pushBackHandler, handleBackPress } from '@/lib/backStack'
import { useActiveConversation, useConversations, useConversationMessages, useMessagesLoading } from '@/lib/conversations'
import { useMemory } from '@/lib/memory'
import { minimizeApp, onAndroidBack, onAppResume } from '@/lib/nativeShell'
import { getReadiness } from '@/lib/readiness'
import { isConfigured, useSettings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { useUpdateStore } from '@/lib/updateStore'
import { useAppearance } from '@/lib/useAppearance'
import { useChat } from '@/lib/useChat'
import { ChatHeader } from '@/ui/ChatHeader'
import { Composer } from '@/ui/Composer'
import { DebugConsole } from '@/ui/DebugConsole'
import { FeatureSheet } from '@/ui/FeatureSheet'
import { MemorySheet } from '@/ui/MemorySheet'
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
  const loadMemory = useMemory((s) => s.load)
  const conversation = useActiveConversation()
  /** Сообщения открытого чата читаются лениво: до загрузки их просто нет */
  const messages = useConversationMessages(conversation?.id)
  const messagesLoading = useMessagesLoading(conversation?.id)
  const { send, stop, regenerate, editAndResend, removeMessage, isStreaming } = useChat()

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  /** Шторки чата: переключатели функций и записи памяти (Android-паттерн). */
  const [featuresOpen, setFeaturesOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)

  const readiness = useMemo(() => getReadiness(settings), [settings])
  const blockingIssue = readiness.issues.find((i) => i.severity === 'error')
  /** Минимум для общения: адрес API + ключ + модель (см. isConfigured). */
  const configured = useMemo(() => isConfigured(settings), [settings])

  useEffect(() => {
    void load()
    void loadMemory()
  }, [load, loadMemory])

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
    if (settingsOpen || debugOpen || setupOpen || featuresOpen || memoryOpen) setSidebarOpen(false)
  }, [settingsOpen, debugOpen, setupOpen, featuresOpen, memoryOpen])

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

  // Аппаратная кнопка «Назад» в APK: нажатие получает верхняя открытая панель
  // (шторка, диалог, меню, сайдбар — см. src/lib/backStack.ts), а когда
  // закрывать нечего — приложение сворачивается.
  useEffect(() => {
    return onAndroidBack(() => {
      if (!handleBackPress()) void minimizeApp()
    })
  }, [])

  // Свои панели тоже участвуют в стеке «Назад» (порядок = порядок открытия)
  useEffect(() => {
    if (!setupOpen) return undefined
    return pushBackHandler(() => setSetupOpen(false))
  }, [setupOpen])

  useEffect(() => {
    if (!settingsOpen) return undefined
    return pushBackHandler(() => setSettingsOpen(false))
  }, [settingsOpen])

  useEffect(() => {
    if (!debugOpen) return undefined
    return pushBackHandler(() => setDebugOpen(false))
  }, [debugOpen])

  useEffect(() => {
    if (!sidebarOpen) return undefined
    return pushBackHandler(() => setSidebarOpen(false))
  }, [sidebarOpen])

  // Вернулись из системных настроек («Установка неизвестных приложений») —
  // сразу доустанавливаем обновление, чтобы не заставлять жать «Установить».
  const retryPendingInstall = useUpdateStore((s) => s.retryPendingInstall)
  useEffect(() => onAppResume(() => void retryPendingInstall()), [retryPendingInstall])

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
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenSettings={openSettings}
          onOpenDebug={openDebug}
          onOpenFeatures={() => setFeaturesOpen(true)}
          onOpenMemory={() => setMemoryOpen(true)}
        />

        {configured ? (
          <MessageList
            conversation={conversation}
            messages={messages ?? []}
            loading={messagesLoading}
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
          onOpenFeatures={() => setFeaturesOpen(true)}
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
      <FeatureSheet
        open={featuresOpen}
        onClose={() => setFeaturesOpen(false)}
        onOpenMemory={() => setMemoryOpen(true)}
      />
      <MemorySheet open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <UpdateDialog />
      <Toaster />
    </div>
  )
}
