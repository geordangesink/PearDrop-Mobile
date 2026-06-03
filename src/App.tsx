/* global __DEV__ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState,
  Animated,
  Alert,
  Modal,
  PanResponder,
  Image,
  Linking,
  Pressable as RNPressable,
  type PressableProps,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as ImagePicker from 'expo-image-picker'
import * as MediaLibrary from 'expo-media-library'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import RPC from 'bare-rpc'
import b4a from 'b4a'
import { zipSync } from 'fflate'
import { Worklet } from 'react-native-bare-kit'
import bundle from './worker.bundle.js'
// @ts-ignore
import { extractInviteUrl, extractShareInviteUrl } from './lib/invite'
// @ts-ignore
import { createWebRtcHost } from './lib/webrtc-host'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowAlert: true
  })
})

const RpcCommand = {
  INIT: 0,
  LIST_TRANSFERS: 1,
  CREATE_UPLOAD: 2,
  GET_MANIFEST: 3,
  DOWNLOAD: 4,
  SHUTDOWN: 5,
  READ_ENTRY: 6,
  LIST_ACTIVE_HOSTS: 7,
  STOP_HOST: 8,
  START_HOST_FROM_TRANSFER: 9,
  READ_ENTRY_CHUNK: 10,
  UPDATE_ACTIVE_HOST: 11,
  LIST_HOST_PEER_ACTIVITY: 12,
  REPORT_HOST_PEER_EVENT: 13,
  SET_PEER_PROFILE: 14,
  CANCEL_OPERATION: 15
} as const

type ThemeMode = 'system' | 'dark' | 'light'
type MainTab = 'upload' | 'download'
type HostPackaging = 'raw' | 'zip'

type FileRecord = {
  id: string
  name: string
  byteLength: number
  updatedAt: number
  source: 'upload' | 'download' | 'local'
  invite: string
  path?: string
  sourceAssetId?: string
  drivePath?: string
  mimeType?: string
  dataBase64?: string
  coverArtDataUrl?: string
}

type HostManifestEntry = {
  name: string
  drivePath?: string
  byteLength?: number
  mimeType?: string
}

type ActiveHost = {
  transferId: string
  invite: string
  webSwarmLink?: string
  sessionName?: string
  sessionLabel?: string
  hostMode?: HostPackaging
  createdAt?: number
  fileCount?: number
  totalBytes?: number
  manifest?: HostManifestEntry[]
  online?: boolean
}

type InviteEntry = {
  name: string
  drivePath: string
  byteLength?: number
  mimeType?: string
}

type WorkerActivityBar = {
  id: string
  label: string
  done: number
  total: number
  subtitle?: string
  displayMode?: 'count' | 'bytes'
  active?: boolean
  etaMs?: number
}

type PreviewItem = {
  name: string
  mimeType?: string
  dataBase64?: string
  uri?: string
}

function localFileIdentityKey(entry: Partial<FileRecord> | null | undefined) {
  const source = String(entry?.source || '').trim()
  if (source !== 'local') return ''
  const path = String(entry?.path || '').trim()
  if (!path) return ''
  return `${source}::${path}`
}

function mergeUniqueLocalFiles(incoming: FileRecord[], existing: FileRecord[]) {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing
  const seen = new Set(existing.map((row) => localFileIdentityKey(row)).filter(Boolean))
  const nextIncoming: FileRecord[] = []
  for (const row of incoming) {
    const key = localFileIdentityKey(row)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    nextIncoming.push(row)
  }
  return [...nextIncoming, ...existing]
}

function dedupeHostableSelection(rows: FileRecord[]) {
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const next: FileRecord[] = []
  for (const row of rows) {
    const key =
      localFileIdentityKey(row) ||
      `${String(row?.source || '')}::${String(row?.invite || '')}::${String(row?.drivePath || row?.path || row?.name || '')}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    next.push(row)
  }
  return next
}

const METADATA_PATH = `${FileSystem.documentDirectory || ''}peardrops-mobile-metadata.json`
const DEFAULT_DEV_RELAY = 'wss://pear-drops.up.railway.app'
const DEFAULT_PROD_RELAY = 'wss://pear-drops.up.railway.app'
const PUBLIC_SITE_ORIGIN = 'https://peardrop.online'
const ANDROID_DOWNLOADS_FILE_URI = 'file:///storage/emulated/0/Download'
const IOS_HOST_STAGING_DIR = `${FileSystem.cacheDirectory || FileSystem.documentDirectory || ''}host-staging`
const MOBILE_WORKER_INIT_TIMEOUT_MS = 45000
let androidDownloadsDirUriCache = ''
const ACTION_ICON_PLAY = '▶'
const ACTION_ICON_COPY = '⧉'
const ACTION_ICON_STOP = '■'

function relayWsToHttp(relayUrl: string, endpointPath: string) {
  try {
    const url = new URL(String(relayUrl || '').trim())
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return ''
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = endpointPath
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

async function postJsonWithRetry(url: string, body: any, attempts = 3) {
  let lastStatus = 0
  let lastError = ''
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      })
      if (response.ok) {
        const data = await response.json().catch(() => ({}))
        return { ok: true, status: response.status, data }
      }
      lastStatus = response.status
      lastError = await response.text().catch(() => '')
    } catch (error: any) {
      lastError = String(error?.message || error || 'request failed')
    }
    if (i < attempts - 1) await sleep(250 * (i + 1))
  }
  return { ok: false, status: lastStatus, error: lastError }
}

function AppPressable({ style, onPressIn, android_ripple, ...props }: PressableProps) {
  return (
    <RNPressable
      {...props}
      android_ripple={android_ripple ?? { color: 'rgba(76, 122, 196, 0.18)' }}
      onPressIn={(event) => {
        void Haptics.selectionAsync().catch(() => {})
        onPressIn?.(event)
      }}
      style={(state) => {
        const resolvedStyle = typeof style === 'function' ? style(state) : style
        return [resolvedStyle, state.pressed && styles.pressFeedback]
      }}
    />
  )
}

type PersistedMetadata = {
  files: FileRecord[]
  starredHosts?: string[]
  hostHistory?: any[]
  hostHistoryRemoved?: string[]
  themeMode?: ThemeMode
  hostPackagingMode?: HostPackaging
  peerName?: string
  onboardingDone?: boolean
}

const envRelay =
  typeof process !== 'undefined' ? String(process.env?.EXPO_PUBLIC_RELAY_URL || '').trim() : ''
const resolvedRelayUrl = envRelay || (__DEV__ ? DEFAULT_DEV_RELAY : DEFAULT_PROD_RELAY)

const updaterConfig = {
  dev: __DEV__,
  version: '0.1.0',
  upgrade: 'pear://updates-disabled',
  relayUrl: resolvedRelayUrl,
  updates: !__DEV__
}

function getTheme(isDark: boolean) {
  if (isDark) {
    return {
      background: '#121212',
      panel: '#161616',
      panelSoft: '#1a1a1a',
      border: '#2a2a2a',
      text: '#f1f3f4',
      muted: '#a4a7ad',
      accent: '#1ba344',
      danger: '#ff9f9f',
      inputPlaceholder: '#a4a7ad'
    }
  }
  return {
    background: '#f4f5f7',
    panel: '#ffffff',
    panelSoft: '#ffffff',
    border: '#d8dce3',
    text: '#171a21',
    muted: '#5e6675',
    accent: '#1ba344',
    danger: '#a53939',
    inputPlaceholder: '#5e6675'
  }
}

export default function App() {
  const systemScheme = useColorScheme()
  const [status, setStatus] = useState('Starting worker...')
  const [workerBooting, setWorkerBooting] = useState(true)
  const [inviteInput, setInviteInput] = useState('')
  const [mainTab, setMainTab] = useState<MainTab>('upload')
  const [history, setHistory] = useState<any[]>([])
  const [hostHistory, setHostHistory] = useState<any[]>([])
  const [hostHistoryRemoved, setHostHistoryRemoved] = useState<Set<string>>(new Set())
  const [selectedHostHistory, setSelectedHostHistory] = useState<Set<string>>(new Set())
  const [selectedActiveHosts, setSelectedActiveHosts] = useState<Set<string>>(new Set())
  const [activeHosts, setActiveHosts] = useState<ActiveHost[]>([])
  const [hostDetailInvite, setHostDetailInvite] = useState('')
  const [hostDetailSourceRefs, setHostDetailSourceRefs] = useState<any[]>([])
  const [hostDetailSelectedRefs, setHostDetailSelectedRefs] = useState<Set<string>>(new Set())
  const [hostDetailApplying, setHostDetailApplying] = useState(false)
  const [files, setFiles] = useState<FileRecord[]>([])
  const [starredHosts, setStarredHosts] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewFile, setPreviewFile] = useState<PreviewItem | null>(null)
  const [metadataLoaded, setMetadataLoaded] = useState(false)
  const [hostNameModalVisible, setHostNameModalVisible] = useState(false)
  const [hostNameDraft, setHostNameDraft] = useState('Host Session')
  const [sessionNameEditVisible, setSessionNameEditVisible] = useState(false)
  const [sessionNameEditDraft, setSessionNameEditDraft] = useState('Host Session')
  const [sessionNameEditInvite, setSessionNameEditInvite] = useState('')
  const [sessionNameEditHistoryKey, setSessionNameEditHistoryKey] = useState('')
  const [hostPackagingMode, setHostPackagingMode] = useState<HostPackaging>('zip')
  const [pendingHostMode, setPendingHostMode] = useState<'selected' | ''>('')
  const [inviteMode, setInviteMode] = useState(false)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteDownloadBusy, setInviteDownloadBusy] = useState(false)
  const [inviteSource, setInviteSource] = useState('')
  const [inviteEntries, setInviteEntries] = useState<InviteEntry[]>([])
  const [inviteRenderCount, setInviteRenderCount] = useState(80)
  const [inviteSelected, setInviteSelected] = useState<Set<string>>(new Set())
  const [invitePreviewThumbs, setInvitePreviewThumbs] = useState<Record<string, string>>({})
  const [invitePreviewLoading, setInvitePreviewLoading] = useState<Set<string>>(new Set())
  const [invitePreviewFull, setInvitePreviewFull] = useState<Record<string, string>>({})
  const previewTranslateY = useRef(new Animated.Value(0)).current
  const skeletonShimmer = useRef(new Animated.Value(0)).current
  const [hostingBusy, setHostingBusy] = useState(false)
  const [hostSelectedPending, setHostSelectedPending] = useState(false)
  const [stoppingInvites, setStoppingInvites] = useState<Set<string>>(new Set())
  const [stoppingSelectedHosts, setStoppingSelectedHosts] = useState(false)
  const [rehostingHistoryKeys, setRehostingHistoryKeys] = useState<Set<string>>(new Set())
  const [workerActivityBars, setWorkerActivityBars] = useState<WorkerActivityBar[]>([])
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const [optionsViewOpen, setOptionsViewOpen] = useState(false)
  const [copyFeedbackKey, setCopyFeedbackKey] = useState('')
  const [peerName, setPeerName] = useState('')
  const [onboardingDone, setOnboardingDone] = useState(false)
  const [hostPeerRows, setHostPeerRows] = useState<any[]>([])
  const [pushTargetId, setPushTargetId] = useState('')
  const [highlightedHostInvite, setHighlightedHostInvite] = useState('')
  const [, setHostPeerLastEventId] = useState(0)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filesRef = useRef<FileRecord[]>([])
  const activeHostsRef = useRef<ActiveHost[]>([])
  const workletRef = useRef<any>(null)
  const rpcRef = useRef<any>(null)
  const appStateRef = useRef<string>(String(AppState.currentState || 'active'))
  const inviteDownloadBusyRef = useRef(false)
  const hostStartupBusyRef = useRef(false)
  const hostOperationIdRef = useRef('')
  const inviteLoadOperationIdRef = useRef('')
  const inviteDownloadOperationIdRef = useRef('')
  const cancelStopSelectedRef = useRef(false)
  const cancelRehostSelectedRef = useRef(false)
  const pendingIosSavePromptRef = useRef<{
    artifacts: Array<{ path: string; name: string; mimeType: string }>
    includePhotos: boolean
  } | null>(null)
  const pendingIosSavePromptRunningRef = useRef(false)
  const notificationsEnabledRef = useRef(false)
  const peerNotifyStateRef = useRef<Map<string, string>>(new Map())
  const activityTimingRef = useRef<Map<string, { startedAt: number; etaMs: number }>>(new Map())
  const invitePreviewLoadRef = useRef<Set<string>>(new Set())
  const webRtcShareHostsRef = useRef<Map<string, any>>(new Map())
  const webRtcShareHostPromisesRef = useRef<Map<string, Promise<string>>>(new Map())
  const uploadScrollRef = useRef<ScrollView | null>(null)
  const hostCardYByInviteRef = useRef<Map<string, number>>(new Map())
  const teardownPromiseRef = useRef<Promise<void> | null>(null)
  const skipFirstDevCleanupRef = useRef(__DEV__)
  const isDark = themeMode === 'system' ? systemScheme !== 'light' : themeMode === 'dark'
  const theme = useMemo(() => getTheme(isDark), [isDark])
  const themed = useMemo(
    () => ({
      container: { backgroundColor: theme.background },
      panel: { backgroundColor: theme.panel, borderColor: theme.border },
      panelSoft: { backgroundColor: theme.panelSoft, borderColor: theme.border },
      iconBadge: { borderColor: theme.border, backgroundColor: theme.panel },
      text: { color: theme.text },
      muted: { color: theme.muted },
      accentBg: { backgroundColor: theme.accent, borderColor: theme.accent },
      accentText: { color: theme.accent },
      dangerText: { color: theme.danger },
      searchInput: {
        backgroundColor: theme.panelSoft,
        borderColor: theme.border,
        color: theme.text
      }
    }),
    [theme]
  )
  const notifyPeerEvent = useCallback(async (title: string, body: string, dedupeKey: string) => {
    if (!notificationsEnabledRef.current) return
    if (!dedupeKey) return
    try {
      await Notifications.scheduleNotificationAsync({
        content: { title, body },
        trigger: null
      })
    } catch {}
  }, [])

  const setWorkerLogMessage = (message: string) => {
    const text = redactInviteText(String(message || '').trim())
    if (text) console.log(`[worker] ${text}`)
  }

  const newOperationId = () => `op:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`

  const cancelOperation = async (operationId: string) => {
    const opId = String(operationId || '').trim()
    if (!opId) return
    try {
      await rpc.request(RpcCommand.CANCEL_OPERATION, { operationId: opId })
    } catch {}
  }

  const cancelOperationOptimistic = (operationId: string, resetUi: () => void) => {
    resetUi()
    void cancelOperation(operationId)
  }

  const formatPeerLabel = (name: string, hex4: string) => {
    const safeName = String(name || '').trim() || 'Unknown'
    const safeHex =
      String(hex4 || '')
        .trim()
        .slice(0, 4) || '----'
    return `${safeName} (${safeHex})`
  }

  const highlightAndScrollToHost = useCallback((inviteRaw: string) => {
    const invite = String(inviteRaw || '').trim()
    if (!invite) return
    setHighlightedHostInvite(invite)
    requestAnimationFrame(() => {
      const y = hostCardYByInviteRef.current.get(invite)
      if (typeof y === 'number') {
        uploadScrollRef.current?.scrollTo({ y: Math.max(0, y - 120), animated: true })
      }
    })
    setTimeout(() => {
      setHighlightedHostInvite((prev) => (prev === invite ? '' : prev))
    }, 1800)
  }, [])

  const flashCopyFeedback = (key: string) => {
    const value = String(key || '').trim()
    if (!value) return
    setCopyFeedbackKey(value)
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopyFeedbackKey('')
      copyFeedbackTimerRef.current = null
    }, 1200)
  }

  const hasWebRtcSignal = (invite: string) => {
    const text = String(invite || '').trim()
    if (!text.startsWith('peardrops-web://join')) return false
    try {
      const parsed = new URL(text)
      return Boolean(String(parsed.searchParams.get('signal') || '').trim())
    } catch {
      return false
    }
  }

  const closeWebRtcShareHost = useCallback((nativeInvite: string) => {
    const key = String(nativeInvite || '').trim()
    if (!key) return
    const host = webRtcShareHostsRef.current.get(key)
    if (host) {
      try {
        void host?.close?.()
      } catch {}
    }
    webRtcShareHostsRef.current.delete(key)
    webRtcShareHostPromisesRef.current.delete(key)
  }, [])

  const closeWebRtcShareHosts = useCallback(() => {
    webRtcShareHostPromisesRef.current.clear()
    for (const host of webRtcShareHostsRef.current.values()) {
      try {
        void host?.close?.()
      } catch {}
    }
    webRtcShareHostsRef.current.clear()
  }, [])

  const ensureWebRtcShareInvite = useCallback(
    async (nativeInvite: string) => {
      const key = String(nativeInvite || '').trim()
      if (!key) return ''
      const cached = webRtcShareHostsRef.current.get(key)
      const isAlive =
        cached && typeof cached.isAlive === 'function' ? Boolean(cached.isAlive()) : false
      if (isAlive && hasWebRtcSignal(String(cached.webLink || ''))) {
        return String(cached.webLink || '')
      }
      if (cached && !isAlive) {
        closeWebRtcShareHost(key)
      }

      const pending = webRtcShareHostPromisesRef.current.get(key)
      if (pending) return pending

      const client = rpcRef.current
      if (!client || typeof client.request !== 'function') {
        throw new Error('Worker is still starting.')
      }

      const creating = createWebRtcHost({
        invite: key,
        rpc: {
          request: (command: number, payload: any) => client.request(command, payload)
        }
      })
        .then((host: any) => {
          webRtcShareHostsRef.current.set(key, host)
          return String(host?.webLink || '').trim()
        })
        .finally(() => {
          webRtcShareHostPromisesRef.current.delete(key)
        })

      webRtcShareHostPromisesRef.current.set(key, creating)
      return creating
    },
    [closeWebRtcShareHost]
  )

  const listActiveHostsWithWebRtc = useCallback(async () => {
    const client = rpcRef.current
    if (!client || typeof client.request !== 'function') return []
    const result = await client.request(RpcCommand.LIST_ACTIVE_HOSTS)
    return Array.isArray(result?.hosts) ? result.hosts : []
  }, [])

  const pruneMissingIndexedFiles = async (reason: 'launch' | 'wakeup') => {
    const current = filesRef.current
    if (!Array.isArray(current) || current.length === 0) return 0

    const checks = await Promise.all(
      current.map(async (item) => {
        const localPath = String(item?.path || '').trim()
        if (!localPath) return { item, exists: true }
        try {
          const info = await FileSystem.getInfoAsync(localPath)
          return { item, exists: !!info?.exists }
        } catch {
          return { item, exists: false }
        }
      })
    )

    const nextFiles = checks.filter((row) => row.exists).map((row) => row.item)
    const removed = current.length - nextFiles.length
    if (removed <= 0) return 0

    const keepIds = new Set(nextFiles.map((item) => String(item.id || '')))
    setFiles(nextFiles)
    setSelected((prev) => new Set(Array.from(prev).filter((id) => keepIds.has(String(id || '')))))
    setWorkerLogMessage(`[files] pruned ${removed} missing path(s) on ${reason}`)
    setStatus(`Removed ${removed} missing file path${removed === 1 ? '' : 's'} from app list.`)
    return removed
  }

  const upsertWorkerActivityBar = (
    id: string,
    label: string,
    done: number,
    total: number,
    options: { subtitle?: string; displayMode?: 'count' | 'bytes'; active?: boolean } = {}
  ) => {
    const key = String(id || '').trim()
    if (!key) return
    const safeTotal = Math.max(1, Number(total || 0))
    const safeDone = Math.max(0, Math.min(safeTotal, Number(done || 0)))
    const now = Date.now()
    const timing = activityTimingRef.current.get(key) || { startedAt: now, etaMs: 0 }
    if (safeDone <= 0) {
      timing.startedAt = now
      timing.etaMs = 0
    } else if (safeDone >= safeTotal) {
      timing.etaMs = 0
    } else {
      const elapsed = Math.max(1, now - timing.startedAt)
      const progress = safeDone / safeTotal
      const projectedTotal = elapsed / Math.max(progress, 1e-6)
      timing.etaMs = Math.max(0, projectedTotal - elapsed)
    }
    activityTimingRef.current.set(key, timing)
    setWorkerActivityBars((prev) => {
      const next = prev.filter((item) => item.id !== key)
      next.push({
        id: key,
        label: String(label || 'Working...'),
        done: safeDone,
        total: safeTotal,
        subtitle: String(options.subtitle || ''),
        displayMode: options.displayMode || 'count',
        active: !!options.active,
        etaMs: timing.etaMs
      })
      return next
    })
  }

  const clearWorkerActivityBar = (id: string) => {
    const key = String(id || '').trim()
    if (!key) return
    activityTimingRef.current.delete(key)
    setWorkerActivityBars((prev) => prev.filter((item) => item.id !== key))
  }

  const rpc = useMemo(() => {
    const worklet = new Worklet()
    workletRef.current = worklet
    worklet.start('/worker.bundle', bundle, [JSON.stringify(updaterConfig)])

    const client = new RPC(worklet.IPC, () => {})

    return {
      async request(command: number, payload = {}) {
        const req = client.request(command)
        req.send(b4a.from(JSON.stringify(payload), 'utf8'))
        const response = await req.reply()
        const parsed = JSON.parse(b4a.toString(response, 'utf8'))
        if (parsed && parsed.ok === false) {
          throw new Error(parsed.error || 'RPC request failed')
        }
        return parsed && parsed.ok === true ? parsed.result : parsed
      },
      destroy() {
        workletRef.current = null
        worklet.terminate()
      }
    }
  }, [])
  rpcRef.current = rpc

  const teardownWorker = useCallback(async () => {
    if (teardownPromiseRef.current) return await teardownPromiseRef.current

    const run = (async () => {
      const client = rpcRef.current
      const invites = new Set<string>()

      for (const host of activeHostsRef.current || []) {
        const invite = extractInviteUrl(String(host?.invite || '').trim())
        if (invite) invites.add(invite)
      }

      if (client && typeof client.request === 'function') {
        try {
          const listed = await client.request(RpcCommand.LIST_ACTIVE_HOSTS)
          const hosts = Array.isArray(listed?.hosts) ? listed.hosts : []
          for (const host of hosts) {
            const invite = extractInviteUrl(String(host?.invite || '').trim())
            if (invite) invites.add(invite)
          }
        } catch {}

        if (invites.size > 0) {
          await Promise.allSettled(
            Array.from(invites).map(async (invite) => {
              await client.request(RpcCommand.STOP_HOST, { invite })
            })
          )
        }
      }

      closeWebRtcShareHosts()

      if (client && typeof client.request === 'function') {
        try {
          await Promise.race([
            client.request(RpcCommand.SHUTDOWN),
            new Promise((resolve) => setTimeout(resolve, 2000))
          ])
        } catch {}
      }

      rpc.destroy()
    })()

    teardownPromiseRef.current = run
    await run
  }, [closeWebRtcShareHosts, rpc])

  useEffect(() => {
    void (async () => {
      setWorkerBooting(true)
      try {
        const initial = await requestInit(rpc)
        setHistory(initial.transfers || [])
        setHostHistory((prev) => mergeHostHistory(prev, initial.transfers || []))
        try {
          const hosts = await listActiveHostsWithWebRtc()
          setActiveHosts(hosts)
        } catch {}
        if (initial.updaterError) {
          setStatus(`Ready (${initial.version}) - updater warning: ${initial.updaterError}`)
          setWorkerLogMessage(`updater warning - ${initial.updaterError}`)
        } else {
          setStatus(`Ready (${initial.version})`)
          setWorkerLogMessage('worker ready')
        }
      } catch (error: any) {
        setStatus(`Init failed: ${error?.message || String(error)}`)
        setWorkerLogMessage(`init failed - ${error?.message || String(error)}`)
      } finally {
        setWorkerBooting(false)
      }
    })()

    return () => {
      // React StrictMode in development mounts/unmounts effects once extra.
      // Skipping the first cleanup prevents tearing down the worker/backend
      // during the dev-only cycle, which can race with host startup.
      if (skipFirstDevCleanupRef.current) {
        skipFirstDevCleanupRef.current = false
        return
      }
      void teardownWorker()
    }
  }, [listActiveHostsWithWebRtc, rpc, teardownWorker])

  useEffect(() => {
    filesRef.current = files
  }, [files])

  useEffect(() => {
    inviteDownloadBusyRef.current = inviteDownloadBusy
  }, [inviteDownloadBusy])

  useEffect(() => {
    hostStartupBusyRef.current = hostingBusy || hostSelectedPending
  }, [hostingBusy, hostSelectedPending])

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(skeletonShimmer, {
        toValue: 1,
        duration: 1100,
        useNativeDriver: true
      })
    )
    skeletonShimmer.setValue(0)
    loop.start()
    return () => {
      loop.stop()
      skeletonShimmer.stopAnimation()
    }
  }, [skeletonShimmer])

  useEffect(() => {
    void (async () => {
      const stored = await loadPersistedMetadata()
      if (!stored) {
        setMetadataLoaded(true)
        return
      }
      setFiles([])
      setStarredHosts(new Set(Array.isArray(stored.starredHosts) ? stored.starredHosts : []))
      setHostHistory(Array.isArray(stored.hostHistory) ? stored.hostHistory : [])
      setHostHistoryRemoved(
        new Set(Array.isArray(stored.hostHistoryRemoved) ? stored.hostHistoryRemoved : [])
      )
      if (
        stored.themeMode === 'dark' ||
        stored.themeMode === 'light' ||
        stored.themeMode === 'system'
      ) {
        setThemeMode(stored.themeMode)
      }
      setPeerName(String(stored.peerName || ''))
      setOnboardingDone(Boolean(stored.onboardingDone))
      setHostPackagingMode(stored.hostPackagingMode === 'raw' ? 'raw' : 'zip')
      setMetadataLoaded(true)
    })()
  }, [])

  useEffect(() => {
    if (!metadataLoaded) return
    const payload: PersistedMetadata = {
      files: [],
      starredHosts: Array.from(starredHosts).slice(0, 300),
      hostHistory: hostHistory.slice(0, 300),
      hostHistoryRemoved: Array.from(hostHistoryRemoved).slice(0, 600),
      themeMode,
      hostPackagingMode,
      peerName,
      onboardingDone
    }
    void savePersistedMetadata(payload)
  }, [
    starredHosts,
    hostHistory,
    hostHistoryRemoved,
    themeMode,
    metadataLoaded,
    hostPackagingMode,
    peerName,
    onboardingDone
  ])

  useEffect(() => {
    const name = String(peerName || '').trim()
    if (!name || !onboardingDone) return
    void rpc.request(RpcCommand.SET_PEER_PROFILE, { name }).catch(() => {})
  }, [rpc, peerName, onboardingDone])

  useEffect(() => {
    if (!inviteMode || !inviteSource || !inviteEntries.length) return
    if (inviteDownloadBusy) return
    const imageEntries = inviteEntries
      .filter(isInviteImageEntry)
      .slice(0, Math.min(inviteRenderCount, 6))
    let cancelled = false
    void (async () => {
      for (const entry of imageEntries) {
        if (cancelled || inviteDownloadBusy) break
        const key = inviteEntryKey(entry)
        if (!key) continue
        if (invitePreviewThumbs[key] || invitePreviewLoadRef.current.has(key)) continue
        await sleep(25)
        if (cancelled || inviteDownloadBusy) break
        await ensureInvitePreview(entry, false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    inviteMode,
    inviteSource,
    inviteEntries,
    invitePreviewThumbs,
    inviteRenderCount,
    inviteDownloadBusy
  ])

  useEffect(() => {
    if (!inviteMode || inviteDownloadBusy) return
    const total = inviteEntries.length
    if (inviteRenderCount >= total) return
    const timer = setTimeout(() => {
      setInviteRenderCount((prev) => Math.min(total, prev + 80))
    }, 90)
    return () => clearTimeout(timer)
  }, [inviteMode, inviteDownloadBusy, inviteEntries.length, inviteRenderCount])

  useEffect(() => {
    if (!metadataLoaded) return
    void pruneMissingIndexedFiles('launch')
  }, [metadataLoaded])

  useEffect(() => {
    const flushPendingIosSavePrompt = async () => {
      if (Platform.OS !== 'ios') return
      if (appStateRef.current !== 'active') return
      if (pendingIosSavePromptRunningRef.current) return
      const pending = pendingIosSavePromptRef.current
      if (!pending || !pending.artifacts.length) return
      pendingIosSavePromptRunningRef.current = true
      pendingIosSavePromptRef.current = null
      try {
        Alert.alert('Download finished', 'Choose where to save downloaded files.')
        const destination = await promptIosDownloadDestination(pending.includePhotos)
        if (!destination) {
          setStatus('Save cancelled.')
          return
        }
        if (destination === 'photos') {
          const savedCount = await saveArtifactsToIosPhotos(pending.artifacts)
          setStatus(
            savedCount > 0
              ? `Saved ${savedCount} file(s) to Photos`
              : 'No compatible media files to save to Photos.'
          )
          return
        }
        try {
          upsertWorkerActivityBar(
            'ios-export',
            'Preparing zip for Files app...',
            0,
            Math.max(1, pending.artifacts.length + 1),
            {
              subtitle: 'Preparing files...',
              displayMode: 'count',
              active: true
            }
          )
          await shareArtifactsToIosFiles(pending.artifacts, (done, total, subtitle) => {
            upsertWorkerActivityBar('ios-export', 'Preparing zip for Files app...', done, total, {
              subtitle,
              displayMode: 'count',
              active: done < total
            })
          })
        } finally {
          clearWorkerActivityBar('ios-export')
        }
        setStatus(
          pending.artifacts.length > 1
            ? `Prepared ${pending.artifacts.length} files for Files app`
            : 'Prepared file for Files app'
        )
      } catch (error: any) {
        setWorkerLogMessage(`ios save prompt failed - ${error?.message || String(error)}`)
      } finally {
        pendingIosSavePromptRunningRef.current = false
      }
    }

    const sub = AppState.addEventListener('change', (nextState) => {
      const stateText = String(nextState || '').trim() || 'active'
      appStateRef.current = stateText
      const hasActiveHosting = (activeHostsRef.current || []).length > 0
      const hasActiveDownload = inviteDownloadBusyRef.current
      const hasHostStartupInFlight = hostStartupBusyRef.current
      const keepWorkerAlive =
        stateText !== 'active' && (hasActiveHosting || hasActiveDownload || hasHostStartupInFlight)
      if (!keepWorkerAlive) {
        try {
          workletRef.current?.update?.(nextState)
        } catch {}
      } else {
        setWorkerLogMessage(
          '[lifecycle] keeping worker unsuspended in background during hosting/download/startup'
        )
      }
      if (stateText === 'active') {
        void pruneMissingIndexedFiles('wakeup')
        void flushPendingIosSavePrompt()
      }
    })
    return () => sub.remove()
  }, [])

  useEffect(() => {
    const applyInvite = (url: string | null) => {
      const invite = extractInviteUrl(url)
      if (!invite) return
      setInviteInput(invite)
      setMainTab('download')
      setStatus('Invite captured from deep link')
      setWorkerLogMessage('deep link invite captured')
    }

    const sub = Linking.addEventListener('url', ({ url }) => applyInvite(url))
    void Linking.getInitialURL().then((url) => applyInvite(url))

    return () => sub.remove()
  }, [])

  useEffect(() => {
    if (mainTab !== 'upload') return
    void refreshHosts()
  }, [mainTab])

  useEffect(() => {
    const activeInviteSet = new Set(
      activeHosts.map((host) => String(host?.invite || '').trim()).filter(Boolean)
    )
    setSelectedActiveHosts((prev) => {
      const next = new Set(Array.from(prev).filter((invite) => activeInviteSet.has(invite)))
      return next
    })
  }, [activeHosts])

  useEffect(() => {
    activeHostsRef.current = activeHosts
  }, [activeHosts])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    }
  }, [])

  const visibleFiles = useMemo(() => {
    return files
      .filter((item) => String(item?.source || '').toLowerCase() === 'local')
      .slice()
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 200)
  }, [files])

  const refresh = async () => {
    const result = await rpc.request(RpcCommand.LIST_TRANSFERS)
    setHistory(result.transfers || [])
    setHostHistory((prev) => mergeHostHistory(prev, result.transfers || []))
  }

  const prewarmWebRtcShareHosts = useCallback(
    async (hosts: ActiveHost[]) => {
      const list = Array.isArray(hosts) ? hosts : []
      await Promise.all(
        list.map(async (host) => {
          const invite = extractInviteUrl(String(host?.invite || '').trim())
          if (!invite) return
          try {
            const resolved = await ensureWebRtcShareInvite(invite)
            if (!hasWebRtcSignal(resolved)) {
              throw new Error('Missing WebRTC signal key in share invite')
            }
          } catch (error: any) {
            setWorkerLogMessage(
              `share link prewarm failed for ${invite.slice(0, 16)}...: ${String(
                error?.message || error || 'unknown error'
              )}`
            )
          }
        })
      )
    },
    [ensureWebRtcShareInvite]
  )

  const refreshHosts = async () => {
    const hosts = await listActiveHostsWithWebRtc()
    setActiveHosts(hosts)
    void prewarmWebRtcShareHosts(hosts)
  }

  useEffect(() => {
    void (async () => {
      try {
        const perms = await Notifications.getPermissionsAsync()
        let granted =
          perms.granted || perms.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
        if (!granted) {
          const requested = await Notifications.requestPermissionsAsync()
          granted =
            requested.granted ||
            requested.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
        }
        notificationsEnabledRef.current = Boolean(granted)
        if (!granted) return
        const extra = (Constants?.expoConfig?.extra || {}) as Record<string, any>
        const projectId =
          String(extra?.eas?.projectId || '') || String(Constants?.easConfig?.projectId || '')
        const tokenResult = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined
        )
        const expoPushToken = String(tokenResult?.data || '').trim()
        if (!expoPushToken) return
        const registerEndpoint = relayWsToHttp(resolvedRelayUrl, '/push/register')
        if (!registerEndpoint) return
        const registerResult = await postJsonWithRetry(
          registerEndpoint,
          {
            expoPushToken,
            platform: Platform.OS,
            appId: String(Constants?.expoConfig?.slug || 'peardrops-mobile')
          },
          5
        )
        if (!registerResult.ok) {
          setWorkerLogMessage(
            `push register failed (${registerResult.status || 'network'}): ${String(
              registerResult.error || ''
            )}`
          )
          return
        }
        const nextTarget = String(registerResult.data?.pushTarget || '').trim()
        if (nextTarget) {
          setPushTargetId(nextTarget)
          setWorkerLogMessage('push registration active')
        }
      } catch {
        notificationsEnabledRef.current = false
      }
    })()
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      try {
        await refreshHosts()
      } catch {}
    }
    void tick()
    const timer = setInterval(() => {
      void tick()
    }, 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [rpc])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      try {
        const response = await rpc.request(RpcCommand.LIST_HOST_PEER_ACTIVITY, {})
        if (cancelled) return
        const peers = Array.isArray(response?.peers) ? response.peers : []
        const events = Array.isArray(response?.events) ? response.events : []
        setHostPeerRows(peers)
        setHostPeerLastEventId((prev) => {
          let next = prev
          for (const event of events) {
            const id = Number(event?.eventId || 0)
            if (!id || id <= prev) continue
            next = Math.max(next, id)
            const type = String(event?.type || '').toLowerCase()
            if (
              !['joined', 'started', 'downloading', 'aborted', 'completed', 'left'].includes(type)
            ) {
              continue
            }
            const label = formatPeerLabel(
              String(event?.peerName || ''),
              String(event?.peerHex4 || '')
            )
            const session = String(event?.sessionName || 'Host Session')
            const peerKey = String(
              event?.peerKeyHex || event?.peerHex4 || event?.peerName || 'peer'
            )
            const notifyKey = `${peerKey}:${session}`
            const message =
              type === 'joined'
                ? `joined ${session}`
                : type === 'downloading'
                  ? `is downloading ${session}`
                  : type === 'started'
                    ? `started downloading ${session}`
                    : type === 'aborted'
                      ? `aborted downloading ${session}`
                      : type === 'left'
                        ? `left ${session}`
                        : `downloaded ${session}`
            setWorkerLogMessage(message)
            const last = peerNotifyStateRef.current.get(notifyKey) || ''
            if (type === 'downloading' && last === 'downloading') continue
            peerNotifyStateRef.current.set(notifyKey, type)
            if (type === 'completed' || type === 'aborted' || type === 'left') {
              peerNotifyStateRef.current.delete(notifyKey)
            }
            void notifyPeerEvent(label, message, notifyKey)
          }
          return next
        })
      } catch {}
    }
    void tick()
    const timer = setInterval(() => {
      void tick()
    }, 1300)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [rpc])

  const onUploadFiles = async () => {
    try {
      const pick = await DocumentPicker.getDocumentAsync({ multiple: true })
      if (pick.canceled || pick.assets.length === 0) return

      upsertWorkerActivityBar('ingest', 'Loading files...', 0, pick.assets.length)
      setStatus(`Loading ${pick.assets.length} file(s)...`)
      setWorkerLogMessage('indexing selected files')
      const now = Date.now()
      const payloadFiles: FileRecord[] = []
      for (let i = 0; i < pick.assets.length; i++) {
        const asset = pick.assets[i]
        const mimeType = asset.mimeType || guessMime(asset.name)
        const coverArtDataUrl = await readMp3CoverArtFromUri(
          asset.uri,
          asset.name,
          mimeType,
          Number(asset.size || 0)
        )
        payloadFiles.push({
          id: `local:${Date.now()}:${asset.name}`,
          name: asset.name,
          byteLength: Number(asset.size || 0),
          updatedAt: now,
          source: 'local',
          invite: '',
          path: asset.uri,
          mimeType,
          coverArtDataUrl
        })
        upsertWorkerActivityBar('ingest', 'Loading files...', i + 1, pick.assets.length)
        if ((i + 1) % 20 === 0) await sleep(0)
      }
      const existingKeys = new Set(
        (Array.isArray(filesRef.current) ? filesRef.current : [])
          .map((row) => localFileIdentityKey(row))
          .filter(Boolean)
      )
      const newlyAddedIds = payloadFiles
        .filter((row) => {
          const key = localFileIdentityKey(row)
          return key && !existingKeys.has(key)
        })
        .map((row) => String(row.id || ''))
        .filter(Boolean)
      let addedCount = 0
      setFiles((prev) => {
        const next = mergeUniqueLocalFiles(payloadFiles, prev)
        addedCount = next.length - prev.length
        return next
      })
      if (newlyAddedIds.length) {
        setSelected((prev) => {
          const next = new Set(prev)
          for (const id of newlyAddedIds) next.add(id)
          return next
        })
      }
      setStatus(`Added ${addedCount} new file(s). Select and tap Host Selected.`)
      setWorkerLogMessage('file indexing complete')
    } catch (error: any) {
      Alert.alert('Upload failed', error?.message || String(error))
    } finally {
      clearWorkerActivityBar('ingest')
    }
  }

  const onUploadMedia = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!permission.granted) {
        Alert.alert('Permission required', 'Allow photo library access to import media.')
        return
      }

      const pick = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsEditing: false,
        allowsMultipleSelection: true,
        quality: 1
      })

      if (pick.canceled || !Array.isArray(pick.assets) || pick.assets.length === 0) return

      upsertWorkerActivityBar('ingest', 'Loading media...', 0, pick.assets.length)
      setStatus(`Loading ${pick.assets.length} media file(s)...`)
      setWorkerLogMessage('indexing selected media')
      const now = Date.now()
      const payloadFiles: FileRecord[] = []
      for (let i = 0; i < pick.assets.length; i++) {
        const asset = pick.assets[i]
        const fallbackName = `media-${i + 1}`
        const name = String(asset.fileName || fallbackName)
        const mimeType = asset.mimeType || guessMime(name)
        payloadFiles.push({
          id: `local:${Date.now()}:${name}:${i}`,
          name,
          byteLength: Number(asset.fileSize || 0),
          updatedAt: now,
          source: 'local',
          invite: '',
          path: String(asset.uri || ''),
          sourceAssetId: String(asset.assetId || ''),
          mimeType
        })
        upsertWorkerActivityBar('ingest', 'Loading media...', i + 1, pick.assets.length)
        if ((i + 1) % 20 === 0) await sleep(0)
      }

      const existingKeys = new Set(
        (Array.isArray(filesRef.current) ? filesRef.current : [])
          .map((row) => localFileIdentityKey(row))
          .filter(Boolean)
      )
      const newlyAddedIds = payloadFiles
        .filter((row) => {
          const key = localFileIdentityKey(row)
          return key && !existingKeys.has(key)
        })
        .map((row) => String(row.id || ''))
        .filter(Boolean)
      let addedCount = 0
      setFiles((prev) => {
        const next = mergeUniqueLocalFiles(payloadFiles, prev)
        addedCount = next.length - prev.length
        return next
      })
      if (newlyAddedIds.length) {
        setSelected((prev) => {
          const next = new Set(prev)
          for (const id of newlyAddedIds) next.add(id)
          return next
        })
      }
      setStatus(`Added ${addedCount} new media file(s). Select and tap Host Selected.`)
      setWorkerLogMessage('media indexing complete')
    } catch (error: any) {
      Alert.alert('Add media failed', error?.message || String(error))
    } finally {
      clearWorkerActivityBar('ingest')
    }
  }

  const onAddSource = () => {
    Alert.alert('Add source', 'Choose what to add.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Media', onPress: () => void onUploadMedia() },
      { text: 'File(s)', onPress: () => void onUploadFiles() }
    ])
  }

  const onHostSelected = async (sessionNameRaw: string, packaging: HostPackaging = 'raw') => {
    if (hostingBusy) return
    const sessionName = String(sessionNameRaw || '').trim() || 'Host Session'
    const picked = dedupeHostableSelection(files.filter((item) => selected.has(item.id)))
    if (!picked.length) {
      Alert.alert('Select files', 'Select one or more files first.')
      return
    }

    try {
      const operationId = newOperationId()
      hostOperationIdRef.current = operationId
      const selectedTotalBytes = picked.reduce(
        (sum, item) => sum + Math.max(0, Number(item?.byteLength || 0)),
        0
      )
      const shouldForceRawForLargeZip = packaging === 'zip' && selectedTotalBytes > 80 * 1024 * 1024
      const effectivePackaging: HostPackaging = shouldForceRawForLargeZip ? 'raw' : packaging
      const rawPayload = (
        await Promise.all(
          picked.map((item) =>
            toUploadPayload(item, rpc, setFiles, {
              preferPath: effectivePackaging === 'raw'
            })
          )
        )
      ).filter(Boolean)

      if (!rawPayload.length) {
        Alert.alert('Not hostable', 'Selected files are not available locally for hosting.')
        return
      }

      let payload = rawPayload
      setHostingBusy(true)
      upsertWorkerActivityBar('host', 'Preparing selected files...', 1, 5)
      if (shouldForceRawForLargeZip) {
        setStatus(
          `Large selection (${formatBytes(selectedTotalBytes)}): using raw hosting for reliability.`
        )
        setWorkerLogMessage(
          `zip packaging bypassed for large selection (${formatBytes(selectedTotalBytes)})`
        )
      }
      if (effectivePackaging === 'zip') {
        setStatus(`Preparing zip package from ${rawPayload.length} file(s)...`)
        setWorkerLogMessage('building zip package')
        payload = [buildZipPayload(rawPayload, sessionName)]
      }
      upsertWorkerActivityBar('host', 'Preparing selected files...', 2, 5)
      setStatus(`Hosting ${rawPayload.length} selected file(s)...`)
      setWorkerLogMessage('creating host session')
      upsertWorkerActivityBar('host', 'Starting host session...', 3, 5)
      const result = await rpc.request(RpcCommand.CREATE_UPLOAD, {
        files: payload,
        sessionName,
        hostMode: effectivePackaging,
        pushTarget: pushTargetId,
        operationId
      })
      upsertWorkerActivityBar('host', 'Generating invite...', 4, 5)
      const createdKey = historyEntryKey(
        result?.transfer || { invite: result?.nativeInvite || result?.invite || '' }
      )
      if (createdKey) {
        setHostHistoryRemoved((prev) => {
          const next = new Set(prev)
          next.delete(createdKey)
          return next
        })
      }
      setHostHistory((prev) =>
        rememberHostHistory(prev, result?.transfer, {
          sessionName,
          hostMode: effectivePackaging,
          manifest: result?.manifest || [],
          invite: result?.nativeInvite || result?.invite || '',
          totalBytes: rawPayload.reduce((sum, item: any) => sum + Number(item?.byteLength || 0), 0),
          fileCount: rawPayload.length,
          sourceRefs: picked
            .map((item) => ({
              type: 'file',
              path: String(item.path || ''),
              name: String(item.name || ''),
              byteLength: Number(item.byteLength || 0)
            }))
            .filter((ref) => ref.path)
        })
      )
      const invite = result.nativeInvite || result.invite
      setMainTab('upload')
      setHostDetailInvite('')
      setHostDetailSourceRefs([])
      setHostDetailSelectedRefs(new Set())
      removeFilesByIds(Array.from(selected))
      upsertWorkerActivityBar('host', 'Host ready', 5, 5)
      setStatus('upload host created.')
      setWorkerLogMessage('host session ready')
      await Promise.all([refresh(), refreshHosts()])
      highlightAndScrollToHost(String(invite || ''))
    } catch (error: any) {
      setWorkerLogMessage(`host upload failed - ${error?.message || String(error)}`)
      Alert.alert('Host failed', error?.message || String(error))
    } finally {
      hostOperationIdRef.current = ''
      setHostingBusy(false)
      setTimeout(() => clearWorkerActivityBar('host'), 700)
    }
  }

  const startHostNamePromptForSelected = () => {
    if (hostingBusy || hostSelectedPending || hostNameModalVisible) return
    setHostSelectedPending(true)
    setPendingHostMode('selected')
    setHostNameDraft('Host Session')
    setHostNameModalVisible(true)
  }

  const loadSourceRefsForInvite = (invite: string) => {
    const merged = mergeHostHistory(
      hostHistory,
      history.filter((item) => item.type === 'upload')
    )
    const match = merged.find((item) => String(item?.invite || '') === String(invite || ''))
    const refs = Array.isArray(match?.sourceRefs) ? match.sourceRefs : []
    return refs
      .map((ref: any) => ({
        id: `hostref:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        type: ref?.type === 'folder' ? 'folder' : 'file',
        path: String(ref?.path || ''),
        name: String(ref?.name || (ref?.path ? ref.path.split('/').pop() : 'Source')),
        byteLength: Number(ref?.byteLength || 0)
      }))
      .filter((ref: any) => ref.path)
  }

  const deriveSourceRefsFromLocalFiles = (invite: string) => {
    const key = String(invite || '').trim()
    if (!key) return []
    const refs: any[] = []
    const seen = new Set<string>()
    const current = Array.isArray(filesRef.current) ? filesRef.current : []
    for (const item of current) {
      if (String(item?.invite || '').trim() !== key) continue
      const refPath = String(item?.path || '').trim()
      if (!refPath) continue
      const dedupeKey = `file::${refPath}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      refs.push({
        id: `hostref:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        type: 'file',
        path: refPath,
        name: String(item?.name || refPath.split('/').pop() || 'Source'),
        byteLength: Number(item?.byteLength || 0)
      })
    }
    return refs
  }

  const openHostDetail = (invite: string) => {
    const host = activeHosts.find((item) => String(item?.invite || '') === String(invite || ''))
    const fromHistory = loadSourceRefsForInvite(invite)
    const fromLocal = deriveSourceRefsFromLocalFiles(invite)
    const refs = fromHistory.length ? fromHistory : fromLocal
    setHostDetailInvite(invite)
    setHostDetailSourceRefs(refs)
    setHostDetailSelectedRefs(new Set())
    setHostDetailApplying(false)
  }

  const toggleHostDetailRefSelect = (id: string) => {
    setHostDetailSelectedRefs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const addHostDetailFiles = async () => {
    if (hostDetailApplying) return
    const pick = await DocumentPicker.getDocumentAsync({ multiple: true })
    if (pick.canceled || !pick.assets.length) return
    setHostDetailSourceRefs((prev) => {
      const existing = new Set(prev.map((ref) => `${ref.type}::${ref.path}`))
      const next = prev.slice()
      for (const asset of pick.assets) {
        const path = String(asset.uri || '').trim()
        if (!path) continue
        const key = `file::${path}`
        if (existing.has(key)) continue
        existing.add(key)
        next.push({
          id: `hostref:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
          type: 'file',
          path,
          name: String(asset.name || path.split('/').pop() || 'File'),
          byteLength: Number(asset.size || 0)
        })
      }
      return next
    })
  }

  const removeSelectedHostDetailRefs = () => {
    if (!hostDetailSelectedRefs.size) return
    setHostDetailSourceRefs((prev) =>
      prev.filter((ref) => !hostDetailSelectedRefs.has(String(ref?.id || '')))
    )
    setHostDetailSelectedRefs(new Set())
  }

  const applyHostDetailChanges = async () => {
    if (!hostDetailInvite || hostDetailApplying) return
    const host = activeHosts.find(
      (item) => String(item.invite || '') === String(hostDetailInvite || '')
    )
    if (!host) {
      Alert.alert('Host unavailable', 'This host session is no longer active.')
      return
    }
    if (!hostDetailSourceRefs.length) {
      Alert.alert('No sources', 'Add at least one source before applying.')
      return
    }

    try {
      setHostDetailApplying(true)
      const prepared = await buildUploadPayloadFromSourceRefs(hostDetailSourceRefs)
      if (prepared.missing.length) {
        await promptContinueWithoutMissingRefs(
          prepared.missing,
          'Apply changes',
          prepared.keptRefs.length
        )
      }
      if (!prepared.payload.length) {
        Alert.alert('No hostable files', 'No readable files remain after removing missing entries.')
        return
      }

      await rpc.request(RpcCommand.STOP_HOST, { invite: hostDetailInvite })
      closeWebRtcShareHost(hostDetailInvite)
      const sessionName =
        String(host.sessionLabel || host.sessionName || 'Host Session').trim() || 'Host Session'
      const result = await rpc.request(RpcCommand.CREATE_UPLOAD, {
        files: prepared.payload,
        sessionName,
        pushTarget: pushTargetId
      })
      const nextInvite = String(result?.nativeInvite || result?.invite || '').trim()
      setHostHistory((prev) =>
        rememberHostHistory(prev, result?.transfer, {
          sessionName,
          manifest: result?.manifest || [],
          invite: nextInvite,
          sourceRefs: prepared.keptRefs
        })
      )
      setHostDetailInvite(nextInvite)
      setHostDetailSourceRefs(
        prepared.keptRefs.map((ref: any) => ({
          id: `hostref:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
          type: 'file',
          path: String(ref.path || ''),
          name: String(ref.name || '')
        }))
      )
      setHostDetailSelectedRefs(new Set())
      setStatus('Session changes applied and host restarted.')
      await Promise.all([refresh(), refreshHosts()])
    } catch (error: any) {
      Alert.alert('Apply failed', error?.message || String(error))
    } finally {
      setHostDetailApplying(false)
    }
  }

  const promptContinueWithoutMissingRefs = async (
    missing: string[],
    actionLabel = 'Host',
    remainingCount = 0
  ) => {
    if (!missing.length) return
    const preview = missing.slice(0, 5).join('\n')
    const tail = missing.length > 5 ? `\n…and ${missing.length - 5} more.` : ''
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        'Missing session sources',
        `${actionLabel} found missing sources:\n\n${preview}${tail}\n\nContinue anyway and remove missing sources?`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continue', onPress: () => resolve(true) }
        ]
      )
    })
    if (!proceed) throw new Error(`${actionLabel} cancelled because some sources were missing`)
    if (remainingCount <= 0) throw new Error('No remaining sources are available to host')
  }

  const buildUploadPayloadFromSourceRefs = async (refs: any[]) => {
    const payload: any[] = []
    const keptRefs: any[] = []
    const missing: string[] = []

    for (const ref of refs) {
      const refPath = String(ref?.path || '').trim()
      if (!refPath) continue
      try {
        // Keep file order deterministic for consistent host manifests.
        // eslint-disable-next-line no-await-in-loop
        const info = await FileSystem.getInfoAsync(refPath)
        if (!info.exists || info.isDirectory) {
          missing.push(refPath)
          continue
        }
        // eslint-disable-next-line no-await-in-loop
        const dataBase64 = await FileSystem.readAsStringAsync(refPath, {
          encoding: FileSystem.EncodingType.Base64
        })
        if (!dataBase64) {
          missing.push(refPath)
          continue
        }
        payload.push({
          name: String(ref?.name || refPath.split('/').pop() || 'file'),
          mimeType: guessMime(String(ref?.name || refPath)),
          dataBase64
        })
        const size = Number((info as any)?.size || ref?.byteLength || 0)
        keptRefs.push({
          type: 'file',
          path: refPath,
          name: String(ref?.name || refPath.split('/').pop() || 'file'),
          byteLength: size
        })
      } catch {
        missing.push(refPath)
      }
    }

    return { payload, keptRefs, missing }
  }

  const restartHostFromHistory = async (item: any) => {
    const transferId = String(item?.id || item?.transferId || '').trim()
    if (!transferId) return
    const rowKey = historyEntryKey(item)
    if (rehostingHistoryKeys.has(rowKey)) return
    const sessionName =
      String(item?.sessionName || item?.sessionLabel || 'Host Session').trim() || 'Host Session'
    try {
      setRehostingHistoryKeys((prev) => {
        const next = new Set(prev)
        if (rowKey) next.add(rowKey)
        return next
      })
      setHostingBusy(true)
      upsertWorkerActivityBar('host', 'Starting host session...', 1, 3)
      setStatus('Starting host from history...')
      setWorkerLogMessage('starting host from history')
      const savedRefs = Array.isArray(item?.sourceRefs) ? item.sourceRefs : []
      let result: any = null
      let resolvedRefs = savedRefs

      if (savedRefs.length) {
        const prepared = await buildUploadPayloadFromSourceRefs(savedRefs)
        if (prepared.missing.length) {
          await promptContinueWithoutMissingRefs(
            prepared.missing,
            'Re-host',
            prepared.keptRefs.length
          )
        }
        if (prepared.payload.length) {
          result = await rpc.request(RpcCommand.CREATE_UPLOAD, {
            files: prepared.payload,
            sessionName,
            pushTarget: pushTargetId
          })
          resolvedRefs = prepared.keptRefs
        }
      }

      if (!result) {
        result = await rpc.request(RpcCommand.START_HOST_FROM_TRANSFER, {
          transferId,
          sessionName,
          pushTarget: pushTargetId
        })
      }
      upsertWorkerActivityBar('host', 'Preparing invite...', 2, 3)
      const reopenedKey = historyEntryKey(
        result?.transfer || { transferId, invite: result?.nativeInvite || result?.invite || '' }
      )
      if (reopenedKey) {
        setSelectedHostHistory((prev) => {
          const next = new Set(prev)
          next.delete(reopenedKey)
          return next
        })
      }
      if (rowKey) {
        setHostHistory((prev) => prev.filter((entry) => historyEntryKey(entry) !== rowKey))
        setHostHistoryRemoved((prev) => {
          const next = new Set(prev)
          next.add(rowKey)
          return next
        })
        setSelectedHostHistory((prev) => {
          const next = new Set(prev)
          next.delete(rowKey)
          return next
        })
      }
      setHostHistory((prev) =>
        rememberHostHistory(prev, result?.transfer, {
          sessionName,
          manifest: result?.manifest || [],
          invite: result?.nativeInvite || result?.invite || '',
          sourceRefs: resolvedRefs
        })
      )
      const invite = result.nativeInvite || result.invite || ''
      if (invite) {
        setMainTab('upload')
        setHostDetailInvite('')
        setHostDetailSourceRefs([])
        setHostDetailSelectedRefs(new Set())
        setStatus('upload host created.')
        setWorkerLogMessage('host from history ready')
      }
      upsertWorkerActivityBar('host', 'Host ready', 3, 3)
      if (reopenedKey) {
        setHostHistoryRemoved((prev) => {
          const next = new Set(prev)
          next.delete(reopenedKey)
          return next
        })
      }
      await Promise.all([refresh(), refreshHosts()])
      highlightAndScrollToHost(String(invite || ''))
    } catch (error: any) {
      setWorkerLogMessage(`host from history failed - ${error?.message || String(error)}`)
      Alert.alert('Host failed', error?.message || String(error))
    } finally {
      setHostingBusy(false)
      setRehostingHistoryKeys((prev) => {
        const next = new Set(prev)
        if (rowKey) next.delete(rowKey)
        return next
      })
      setTimeout(() => clearWorkerActivityBar('host'), 700)
    }
  }

  const submitHostNameModal = async () => {
    const sessionName = String(hostNameDraft || '').trim() || 'Host Session'
    setHostNameModalVisible(false)
    try {
      if (pendingHostMode === 'selected') {
        await onHostSelected(sessionName, hostPackagingMode)
        return
      }
    } catch (error: any) {
      setWorkerLogMessage(`host from history failed - ${error?.message || String(error)}`)
      Alert.alert('Host failed', error?.message || String(error))
    } finally {
      setHostingBusy(false)
      setHostSelectedPending(false)
      setTimeout(() => clearWorkerActivityBar('host'), 700)
      setPendingHostMode('')
    }
  }

  const dismissHostNameModal = () => {
    setHostNameModalVisible(false)
    setPendingHostMode('')
    setHostSelectedPending(false)
  }

  const openSessionNameEditor = (opts: {
    invite?: string
    historyKey?: string
    current?: string
  }) => {
    setSessionNameEditInvite(String(opts.invite || '').trim())
    setSessionNameEditHistoryKey(String(opts.historyKey || '').trim())
    setSessionNameEditDraft(String(opts.current || 'Host Session').trim() || 'Host Session')
    setSessionNameEditVisible(true)
  }

  const closeSessionNameEditor = () => {
    setSessionNameEditVisible(false)
    setSessionNameEditInvite('')
    setSessionNameEditHistoryKey('')
    setSessionNameEditDraft('Host Session')
  }

  const applySessionNameEdit = () => {
    const nextLabel = String(sessionNameEditDraft || '').trim() || 'Host Session'
    const inviteKey = String(sessionNameEditInvite || '').trim()
    const rowKey = String(sessionNameEditHistoryKey || '').trim()
    if (!inviteKey && !rowKey) {
      closeSessionNameEditor()
      return
    }

    setActiveHosts((prev) =>
      prev.map((host) =>
        inviteKey && String(host?.invite || '').trim() === inviteKey
          ? { ...host, sessionLabel: nextLabel, sessionName: nextLabel }
          : host
      )
    )
    setHostHistory((prev) =>
      prev.map((item) => {
        const itemInvite = String(item?.invite || '').trim()
        const itemKey = historyEntryKey(item)
        if ((inviteKey && itemInvite === inviteKey) || (rowKey && itemKey === rowKey)) {
          return {
            ...item,
            sessionLabel: nextLabel,
            sessionName: nextLabel
          }
        }
        return item
      })
    )
    closeSessionNameEditor()
  }

  const onDownload = async () => {
    if (inviteLoading) return
    const invite = extractInviteUrl(inviteInput.trim())
    if (!invite) {
      Alert.alert('Invite required', 'Paste a valid invite link first.')
      return
    }

    try {
      void sendJoinPushPing(invite, 'Host Session')
      const operationId = newOperationId()
      inviteLoadOperationIdRef.current = operationId
      setInviteLoading(true)
      setInviteMode(false)
      setInviteEntries([])
      setInviteRenderCount(80)
      setInviteSelected(new Set())
      setInvitePreviewThumbs({})
      setInvitePreviewFull({})
      setInvitePreviewLoading(new Set())
      invitePreviewLoadRef.current = new Set()
      setStatus('Loading invite files...')
      setWorkerLogMessage('loading invite manifest')
      const manifest = await rpc.request(RpcCommand.GET_MANIFEST, { invite, operationId })
      const entries = Array.isArray(manifest.files) ? manifest.files : []
      setInviteSource(invite)
      setInviteEntries(entries)
      setInviteRenderCount(Math.min(80, entries.length))
      setInviteSelected(
        new Set(entries.map((item: InviteEntry) => String(item.drivePath || item.name)))
      )
      setInviteMode(true)
      setStatus(`Loaded ${entries.length} invite file(s)`)
      setWorkerLogMessage('invite manifest loaded')
    } catch (error: any) {
      setWorkerLogMessage(`invite load failed - ${error?.message || String(error)}`)
      Alert.alert('Invite load failed', error?.message || String(error))
    } finally {
      inviteLoadOperationIdRef.current = ''
      setInviteLoading(false)
    }
  }

  const copyInviteIntoDownload = async (
    invite: string,
    feedbackKey = '',
    nativeInviteForWebRtc = '',
    options: { requireWebRtc?: boolean } = {}
  ) => {
    const raw = String(invite || '').trim()
    const fallbackNative = extractInviteUrl(String(nativeInviteForWebRtc || raw || '').trim())
    try {
      const requireWebRtc = options.requireWebRtc === true
      let resolved = extractShareInviteUrl(raw) || raw
      if (requireWebRtc && !hasWebRtcSignal(resolved)) {
        const candidateNative =
          fallbackNative || extractInviteUrl(raw) || String(nativeInviteForWebRtc || '').trim()
        if (candidateNative) {
          const webrtcInvite = await ensureWebRtcShareInvite(candidateNative)
          if (hasWebRtcSignal(webrtcInvite)) {
            resolved = webrtcInvite
          }
        }
      }
      if (!resolved) {
        throw new Error('Invite is still initializing. Please try again in a moment.')
      }
      if (requireWebRtc && !hasWebRtcSignal(resolved)) {
        const nativeFallback = fallbackNative || extractInviteUrl(raw)
        if (nativeFallback) resolved = nativeFallback
        else throw new Error('WebRTC invite not ready yet. Please try again in a moment.')
      }
      const shareLink = `${PUBLIC_SITE_ORIGIN}/open/?invite=${encodeURIComponent(resolved)}`
      await Clipboard.setStringAsync(shareLink)
      flashCopyFeedback(feedbackKey || `copy:${resolved}`)
      if (hasWebRtcSignal(resolved)) {
        setStatus('WebRTC invite link copied to clipboard.')
      } else {
        setStatus('Native invite link copied to clipboard.')
      }
    } catch (error: any) {
      const message = String(error?.message || error || '').trim()
      setWorkerLogMessage(`invite copy failed - ${message || 'unknown error'}`)
      Alert.alert('Invite not ready', message || 'WebRTC invite is still initializing.')
    }
  }

  const toggleStarHostInvite = (invite: string) => {
    const value = String(invite || '').trim()
    if (!value) return
    setStarredHosts((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const toggleInviteSelect = (entry: InviteEntry) => {
    const key = String(entry.drivePath || entry.name)
    setInviteSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleInviteSelectAll = () => {
    const allSelected =
      inviteEntries.length > 0 &&
      inviteEntries.every((entry) => inviteSelected.has(String(entry.drivePath || entry.name)))
    if (allSelected) {
      setInviteSelected(new Set())
      return
    }
    setInviteSelected(new Set(inviteEntries.map((entry) => String(entry.drivePath || entry.name))))
  }

  const inviteEntryKey = (entry: InviteEntry) => String(entry.drivePath || entry.name || '').trim()

  const isInviteImageEntry = (entry: InviteEntry) => {
    const mime = String(entry?.mimeType || '').toLowerCase()
    if (mime.startsWith('image/')) return true
    const ext = fileExt(String(entry?.name || '')).toLowerCase()
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'].includes(ext)
  }

  const readInviteEntryBase64 = async (entry: InviteEntry) => {
    if (!inviteSource) return ''
    const expectedFileBytes = Math.max(0, Number(entry.byteLength || 0))
    let fileDone = 0
    const chunks: string[] = []
    if (expectedFileBytes > 0) {
      while (fileDone < expectedFileBytes) {
        const chunk = await rpc.request(RpcCommand.READ_ENTRY_CHUNK, {
          invite: inviteSource,
          drivePath: entry.drivePath,
          offset: fileDone,
          length: Math.min(256 * 1024, expectedFileBytes - fileDone)
        })
        const dataBase64Chunk = String(chunk?.dataBase64 || '')
        if (!dataBase64Chunk) break
        const chunkBytes = Math.max(0, Number(chunk?.byteLength || 0))
        if (!chunkBytes) break
        chunks.push(dataBase64Chunk)
        fileDone += chunkBytes
      }
      return chunks.join('')
    }
    const read = await rpc.request(RpcCommand.READ_ENTRY, {
      invite: inviteSource,
      drivePath: entry.drivePath
    })
    return String(read?.dataBase64 || '')
  }

  const ensureInvitePreview = async (entry: InviteEntry, withFull = false) => {
    if (!isInviteImageEntry(entry)) return { thumbDataBase64: '', fullDataBase64: '' }
    const key = inviteEntryKey(entry)
    if (!key) return { thumbDataBase64: '', fullDataBase64: '' }
    const existingThumb = String(invitePreviewThumbs[key] || '')
    const existingFull = String(invitePreviewFull[key] || '')
    if (existingThumb && (!withFull || existingFull)) {
      return { thumbDataBase64: existingThumb, fullDataBase64: existingFull }
    }
    if (invitePreviewLoadRef.current.has(key)) {
      return { thumbDataBase64: existingThumb, fullDataBase64: existingFull }
    }

    invitePreviewLoadRef.current.add(key)
    setInvitePreviewLoading((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      const fullDataBase64 = await readInviteEntryBase64(entry)
      if (!fullDataBase64) return { thumbDataBase64: '', fullDataBase64: '' }
      setInvitePreviewThumbs((prev) => ({ ...prev, [key]: fullDataBase64 }))
      if (withFull) {
        setInvitePreviewFull((prev) => ({ ...prev, [key]: fullDataBase64 }))
      }
      return { thumbDataBase64: fullDataBase64, fullDataBase64: withFull ? fullDataBase64 : '' }
    } catch {
      return { thumbDataBase64: '', fullDataBase64: '' }
    } finally {
      invitePreviewLoadRef.current.delete(key)
      setInvitePreviewLoading((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const openInviteEntryPreview = async (entry: InviteEntry) => {
    if (!isInviteImageEntry(entry)) {
      setPreviewFile({
        name: String(entry?.name || 'File'),
        mimeType: String(entry?.mimeType || guessMime(entry?.name || 'file'))
      })
      previewTranslateY.setValue(0)
      return
    }
    const key = inviteEntryKey(entry)
    const mimeType = String(entry?.mimeType || guessMime(entry?.name || 'file'))
    const cachedFull = String(invitePreviewFull[key] || invitePreviewThumbs[key] || '')
    if (cachedFull) {
      setPreviewFile({
        name: String(entry?.name || 'Image'),
        mimeType,
        dataBase64: cachedFull
      })
      previewTranslateY.setValue(0)
      return
    }
    const loaded = await ensureInvitePreview(entry, true)
    const fullDataBase64 = loaded.fullDataBase64 || loaded.thumbDataBase64
    if (!fullDataBase64) {
      Alert.alert('Preview unavailable', 'Could not load preview for this file.')
      return
    }
    setPreviewFile({
      name: String(entry?.name || 'Image'),
      mimeType,
      dataBase64: fullDataBase64
    })
    previewTranslateY.setValue(0)
  }

  const openHostSourcePreview = async (ref: any) => {
    const path = String(ref?.path || '').trim()
    const name = String(ref?.name || path.split('/').pop() || 'Source')
    const mimeType = guessMime(name)
    const isImage = String(mimeType || '').startsWith('image/')
    if (!path) return
    if (!isImage) {
      setPreviewFile({ name, mimeType })
      previewTranslateY.setValue(0)
      return
    }
    setPreviewFile({ name, mimeType, uri: path })
    previewTranslateY.setValue(0)
  }

  const downloadInviteSelected = async () => {
    if (inviteDownloadBusy) return
    const selectedEntries = inviteEntries.filter((entry) =>
      inviteSelected.has(String(entry.drivePath || entry.name))
    )
    const picked = selectedEntries
    if (!picked.length) {
      Alert.alert('Select files', 'Select one or more drive files first.')
      return
    }
    setInviteDownloadBusy(true)
    const operationId = newOperationId()
    inviteDownloadOperationIdRef.current = operationId
    setStatus('Preparing download...')
    setWorkerLogMessage('preparing selected invite files')
    const normalizedPeerName = String(peerName || '').trim()
    try {
      void sendJoinPushPing(inviteSource, 'Host Session')
      const shouldDownload = true
      const allMediaForIosPhotos =
        Platform.OS === 'ios' &&
        picked.every((entry) =>
          isIosPhotosCompatibleMedia(
            entry.mimeType || guessMime(entry.name),
            String(entry.name || '')
          )
        )
      setStatus(`Downloading ${picked.length} file(s)...`)
      setWorkerLogMessage('downloading selected invite files')
      const knownTotalBytes = picked.reduce(
        (sum, entry) => sum + Math.max(0, Number(entry?.byteLength || 0)),
        0
      )
      const useByteProgress = knownTotalBytes > 0
      const totalForProgress = useByteProgress ? knownTotalBytes : picked.length
      let downloadedBytes = 0
      upsertWorkerActivityBar('download', 'Downloading selected files...', 0, totalForProgress, {
        subtitle: 'Current file: preparing...',
        displayMode: useByteProgress ? 'bytes' : 'count'
      })
      const defaultDir = `${FileSystem.documentDirectory || ''}downloads`
      let androidDownloadsDirUri = ''
      let androidDownloadMode: 'direct' | 'saf' = 'direct'
      const iosDownloadedArtifacts: Array<{ path: string; name: string; mimeType: string }> = []
      if (shouldDownload) {
        if (Platform.OS === 'android') {
          const canDirectWrite = await canWriteAndroidPublicDownloads()
          if (!canDirectWrite) {
            androidDownloadMode = 'saf'
            androidDownloadsDirUri = await resolveAndroidDownloadsDirUri()
            if (!androidDownloadsDirUri) {
              Alert.alert(
                'Downloads permission needed',
                'Grant access to your Downloads folder to save files there.'
              )
              return
            }
          }
        } else {
          await FileSystem.makeDirectoryAsync(defaultDir, { intermediates: true })
        }
      }

      if (normalizedPeerName) {
        void rpc
          .request(RpcCommand.REPORT_HOST_PEER_EVENT, {
            invite: inviteSource,
            peerName: normalizedPeerName,
            type: 'downloading',
            progress: 0
          })
          .catch(() => {})
      }

      for (let i = 0; i < picked.length; i++) {
        const entry = picked[i]
        upsertWorkerActivityBar(
          'download',
          'Downloading selected files...',
          useByteProgress ? downloadedBytes : i,
          totalForProgress,
          {
            subtitle: `Current file: ${entry.name || `file-${i + 1}`}`,
            displayMode: useByteProgress ? 'bytes' : 'count'
          }
        )
        const expectedFileBytes = Math.max(0, Number(entry.byteLength || 0))
        let fileDone = 0
        const safeName = sanitizeFileName(String(entry.name || `file-${i + 1}`))
        let localDownloadPath = ''
        let androidDownloadFileUri = ''
        if (shouldDownload) {
          if (Platform.OS === 'android') {
            if (androidDownloadMode === 'saf') {
              androidDownloadFileUri = await createAndroidDownloadFileUri(
                androidDownloadsDirUri,
                safeName,
                entry.mimeType || guessMime(safeName)
              )
            } else {
              localDownloadPath = `${ANDROID_DOWNLOADS_FILE_URI}/${safeName}`
              await FileSystem.deleteAsync(localDownloadPath, { idempotent: true }).catch(() => {})
            }
          } else {
            localDownloadPath = `${defaultDir}/${safeName}`
            await FileSystem.deleteAsync(localDownloadPath, { idempotent: true }).catch(() => {})
          }
        }

        if (expectedFileBytes > 0) {
          while (fileDone < expectedFileBytes) {
            const chunk = await rpc.request(RpcCommand.READ_ENTRY_CHUNK, {
              invite: inviteSource,
              drivePath: entry.drivePath,
              offset: fileDone,
              length: Math.min(256 * 1024, expectedFileBytes - fileDone),
              operationId
            })
            const dataBase64Chunk = String(chunk?.dataBase64 || '')
            if (!dataBase64Chunk) break
            const chunkBytes = Math.max(0, Number(chunk?.byteLength || 0))
            if (!chunkBytes) break
            if (shouldDownload) {
              if (Platform.OS === 'android') {
                if (androidDownloadMode === 'saf') {
                  await FileSystem.StorageAccessFramework.writeAsStringAsync(
                    androidDownloadFileUri,
                    dataBase64Chunk,
                    {
                      encoding: FileSystem.EncodingType.Base64,
                      append: fileDone > 0
                    }
                  )
                } else {
                  await FileSystem.writeAsStringAsync(localDownloadPath, dataBase64Chunk, {
                    encoding: FileSystem.EncodingType.Base64,
                    append: fileDone > 0
                  })
                }
              } else {
                await FileSystem.writeAsStringAsync(localDownloadPath, dataBase64Chunk, {
                  encoding: FileSystem.EncodingType.Base64,
                  append: fileDone > 0
                })
              }
            }
            fileDone += chunkBytes
            downloadedBytes += chunkBytes
            if (normalizedPeerName && knownTotalBytes > 0) {
              void rpc
                .request(RpcCommand.REPORT_HOST_PEER_EVENT, {
                  invite: inviteSource,
                  peerName: normalizedPeerName,
                  type: 'downloading',
                  progress: Math.max(0, Math.min(1, downloadedBytes / knownTotalBytes))
                })
                .catch(() => {})
            }
            upsertWorkerActivityBar(
              'download',
              'Downloading selected files...',
              useByteProgress ? downloadedBytes : i,
              totalForProgress,
              {
                subtitle: `Current file: ${entry.name || `file-${i + 1}`}`,
                displayMode: useByteProgress ? 'bytes' : 'count'
              }
            )
          }
        } else {
          const read = await rpc.request(RpcCommand.READ_ENTRY, {
            invite: inviteSource,
            drivePath: entry.drivePath,
            operationId
          })
          const dataBase64 = String(read.dataBase64 || '')
          fileDone = Math.max(0, Number(read.byteLength || 0))
          if (shouldDownload && dataBase64) {
            if (Platform.OS === 'android') {
              if (androidDownloadMode === 'saf') {
                await FileSystem.StorageAccessFramework.writeAsStringAsync(
                  androidDownloadFileUri,
                  dataBase64,
                  {
                    encoding: FileSystem.EncodingType.Base64
                  }
                )
              } else {
                await FileSystem.writeAsStringAsync(localDownloadPath, dataBase64, {
                  encoding: FileSystem.EncodingType.Base64
                })
              }
            } else {
              await FileSystem.writeAsStringAsync(localDownloadPath, dataBase64, {
                encoding: FileSystem.EncodingType.Base64
              })
            }
          }
          downloadedBytes += fileDone
        }

        if (shouldDownload && Platform.OS === 'ios' && localDownloadPath) {
          iosDownloadedArtifacts.push({
            path: localDownloadPath,
            name: safeName,
            mimeType: entry.mimeType || guessMime(safeName),
            byteLength: fileDone
          })
        }
        upsertWorkerActivityBar(
          'download',
          'Downloading selected files...',
          useByteProgress ? downloadedBytes : i + 1,
          totalForProgress,
          {
            subtitle: `Current file: ${entry.name || `file-${i + 1}`}`,
            displayMode: useByteProgress ? 'bytes' : 'count'
          }
        )
      }

      if (normalizedPeerName) {
        void rpc
          .request(RpcCommand.REPORT_HOST_PEER_EVENT, {
            invite: inviteSource,
            peerName: normalizedPeerName,
            type: 'completed',
            progress: 1
          })
          .catch(() => {})
      }

      await refresh()
      if (Platform.OS === 'ios' && shouldDownload) {
        if (appStateRef.current !== 'active') {
          pendingIosSavePromptRef.current = {
            artifacts: iosDownloadedArtifacts,
            includePhotos: Boolean(allMediaForIosPhotos)
          }
          setStatus('Download finished in background. Reopen app to choose save destination.')
          setWorkerLogMessage('download finished in background; save prompt queued')
        } else {
          const destination = await promptIosDownloadDestination(Boolean(allMediaForIosPhotos))
          if (!destination) {
            setStatus('Save cancelled.')
            return
          }
          if (destination === 'photos') {
            const savedCount = await saveArtifactsToIosPhotos(iosDownloadedArtifacts)
            setStatus(
              savedCount > 0
                ? `Saved ${savedCount} file(s) to Photos`
                : 'No compatible media files to save to Photos.'
            )
          } else {
            try {
              upsertWorkerActivityBar(
                'ios-export',
                'Preparing zip for Files app...',
                0,
                Math.max(1, iosDownloadedArtifacts.length + 1),
                {
                  subtitle: 'Preparing files...',
                  displayMode: 'count',
                  active: true
                }
              )
              await shareArtifactsToIosFiles(iosDownloadedArtifacts, (done, total, subtitle) => {
                upsertWorkerActivityBar(
                  'ios-export',
                  'Preparing zip for Files app...',
                  done,
                  total,
                  {
                    subtitle,
                    displayMode: 'count',
                    active: done < total
                  }
                )
              })
            } finally {
              clearWorkerActivityBar('ios-export')
            }
            setStatus(
              iosDownloadedArtifacts.length > 1
                ? `Prepared ${iosDownloadedArtifacts.length} files for Files app`
                : 'Prepared file for Files app'
            )
          }
        }
      } else {
        setStatus(
          Platform.OS === 'android'
            ? `Downloaded ${picked.length} file(s) to Downloads`
            : `Downloaded ${picked.length} file(s)`
        )
      }
      setWorkerLogMessage('download completed')
    } catch (error: any) {
      if (normalizedPeerName) {
        void rpc
          .request(RpcCommand.REPORT_HOST_PEER_EVENT, {
            invite: inviteSource,
            peerName: normalizedPeerName,
            type: 'aborted'
          })
          .catch(() => {})
      }
      setWorkerLogMessage(`download failed - ${error?.message || String(error)}`)
      Alert.alert('Download failed', error?.message || String(error))
    } finally {
      inviteDownloadOperationIdRef.current = ''
      setInviteDownloadBusy(false)
      clearWorkerActivityBar('download')
    }
  }

  const sendJoinPushPing = async (inviteRaw: string, sessionName: string) => {
    try {
      const invite = extractInviteUrl(String(inviteRaw || '').trim())
      if (!invite) return
      const url = new URL(invite)
      const pushTarget = String(url.searchParams.get('push') || '').trim()
      if (!pushTarget) return
      const relayUrl = String(url.searchParams.get('relay') || resolvedRelayUrl || '').trim()
      const endpoint = relayWsToHttp(relayUrl, '/push/join-request')
      if (!endpoint) return
      const normalizedPeerName = String(peerName || '').trim()
      await postJsonWithRetry(
        endpoint,
        {
          pushTarget,
          invite,
          sessionName: String(sessionName || 'Host Session').trim() || 'Host Session',
          peerName: normalizedPeerName
        },
        3
      )
    } catch {}
  }

  const removeFilesByIds = (ids: string[]) => {
    const idSet = new Set(ids.map((id) => String(id || '')).filter(Boolean))
    if (!idSet.size) return
    setFiles((prev) => prev.filter((item) => !idSet.has(item.id)))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of idSet) next.delete(id)
      return next
    })
  }

  const toggleDelete = (id: string) => {
    removeFilesByIds([id])
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const removeSelectedLocal = () => {
    if (!selected.size) return
    const ids = Array.from(selected)
    removeFilesByIds(ids)
  }

  const toggleSelectAllLocalSources = () => {
    if (!visibleFiles.length) return
    const allSelected = visibleFiles.every((item) => selected.has(item.id))
    setSelected(allSelected ? new Set() : new Set(visibleFiles.map((item) => item.id)))
  }

  const themeModeMeta = {
    system: { icon: '◫', label: 'System' },
    dark: { icon: '◼', label: 'Dark' },
    light: { icon: '◻', label: 'Light' }
  } as const

  const stopActiveHost = async (invite: string) => {
    const key = String(invite || '').trim()
    if (!key || stoppingInvites.has(key)) return
    try {
      setStoppingInvites((prev) => {
        const next = new Set(prev)
        next.add(key)
        return next
      })
      await rpc.request(RpcCommand.STOP_HOST, { invite })
      closeWebRtcShareHost(key)
      setStarredHosts((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      if (hostDetailInvite === invite) {
        setHostDetailInvite('')
        setHostDetailSourceRefs([])
        setHostDetailSelectedRefs(new Set())
      }
      await refreshHosts()
      setStatus('Hosting stopped')
    } catch (error: any) {
      Alert.alert('Stop host failed', error?.message || String(error))
    } finally {
      setStoppingInvites((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const removeHistoryItems = (items: any[]) => {
    const keys = items.map((item) => historyEntryKey(item)).filter(Boolean)
    if (!keys.length) return
    const invitesToRemove = new Set(
      items.map((item) => String(item?.invite || '').trim()).filter(Boolean)
    )
    const removeSet = new Set(keys)
    setHostHistory((prev) => prev.filter((item) => !removeSet.has(historyEntryKey(item))))
    if (invitesToRemove.size) {
      setStarredHosts((prev) => {
        let changed = false
        const next = new Set(prev)
        for (const invite of invitesToRemove) {
          if (next.delete(invite)) changed = true
        }
        return changed ? next : prev
      })
    }
    setHostHistoryRemoved((prev) => {
      const next = new Set(prev)
      for (const key of keys) next.add(key)
      return next
    })
    setSelectedHostHistory((prev) => {
      const next = new Set(prev)
      for (const key of keys) next.delete(key)
      return next
    })
  }

  const startSelectedHistoryHosts = async (rows: any[]) => {
    if (hostingBusy) {
      cancelRehostSelectedRef.current = true
      setStatus('Re-hosting cancelled.')
      return
    }
    const picked = rows.filter((item) => selectedHostHistory.has(historyEntryKey(item)))
    if (!picked.length) {
      Alert.alert('Select history', 'Select one or more history items first.')
      return
    }
    cancelRehostSelectedRef.current = false
    for (const item of picked) {
      if (cancelRehostSelectedRef.current) break
      // Keep host restart sequence explicit and stable.
      // eslint-disable-next-line no-await-in-loop
      await restartHostFromHistory(item)
    }
    cancelRehostSelectedRef.current = false
  }

  const toggleSelectHostHistory = (item: any) => {
    const key = historyEntryKey(item)
    if (!key) return
    setSelectedHostHistory((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSelectActiveHost = (invite: string) => {
    const key = String(invite || '').trim()
    if (!key) return
    setSelectedActiveHosts((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSelectAllActiveHosts = () => {
    if (!activeHosts.length) return
    const invites = activeHosts.map((host) => String(host?.invite || '').trim()).filter(Boolean)
    const allSelected =
      invites.length > 0 && invites.every((invite) => selectedActiveHosts.has(invite))
    setSelectedActiveHosts(allSelected ? new Set() : new Set(invites))
  }

  const toggleSelectAllHistoryHosts = (rows: any[]) => {
    const keys = rows.map((item) => historyEntryKey(item)).filter(Boolean)
    if (!keys.length) return
    const allSelected = keys.every((key) => selectedHostHistory.has(key))
    setSelectedHostHistory(allSelected ? new Set() : new Set(keys))
  }

  const stopSelectedActiveHosts = async () => {
    if (stoppingSelectedHosts) {
      cancelStopSelectedRef.current = true
      setStatus('Stopping selected hosts cancelled.')
      return
    }
    const invites = Array.from(selectedActiveHosts).filter(Boolean)
    if (!invites.length) {
      Alert.alert('Select hosts', 'Select one or more active hosts first.')
      return
    }
    setStoppingSelectedHosts(true)
    cancelStopSelectedRef.current = false
    try {
      for (const invite of invites) {
        if (cancelStopSelectedRef.current) break
        // Keep stop order deterministic for easier user feedback.
        // eslint-disable-next-line no-await-in-loop
        await stopActiveHost(invite)
      }
      if (!cancelStopSelectedRef.current) {
        setSelectedActiveHosts(new Set())
      }
    } finally {
      setStoppingSelectedHosts(false)
      cancelStopSelectedRef.current = false
    }
  }

  const renderHostContent = () => {
    if (hostDetailInvite) {
      const host = activeHosts.find((item) => item.invite === hostDetailInvite)
      if (!host) {
        return <Text style={[styles.muted, themed.muted]}>Host session is no longer active.</Text>
      }
      const label = parseHostSessionLabel(host.sessionLabel || host.sessionName || 'Host Session')
      const dateLine = formatHostSessionDateLine(host.createdAt, label.embeddedDateTime)
      const stopKey = String(host.invite || '').trim()
      const isStopping = stopKey ? stoppingInvites.has(stopKey) : false
      return (
        <View style={styles.hostSection}>
          <View style={styles.hostDetailHead}>
            <AppPressable
              style={styles.backArrowBtn}
              onPress={() => {
                setHostDetailInvite('')
                setHostDetailSourceRefs([])
                setHostDetailSelectedRefs(new Set())
              }}
            >
              <Text style={[styles.backArrowText, themed.text]}>←</Text>
            </AppPressable>
            <Text style={[styles.hostDetailTitle, themed.text]}>Host session</Text>
          </View>
          <View style={[styles.hostCard, themed.panel]}>
            <Text style={[styles.hostCardTitle, themed.text]}>
              {label.title}
              {label.hash ? <Text style={styles.hostHashInline}> ({label.hash})</Text> : null}
            </Text>
            <Text style={[styles.hostMetaDate, themed.muted]}>{dateLine || '—'}</Text>
            <Text style={[styles.hostMetaSize, themed.muted]}>
              {formatBytes(Number(host.totalBytes || 0))}{' '}
              {host.fileCount ? `• ${host.fileCount} files` : ''}
            </Text>
            <View style={styles.hostCardActions}>
              <AppPressable
                style={[styles.rowBtn, themed.panelSoft]}
                onPress={() => toggleStarHostInvite(host.invite)}
              >
                <Text style={[styles.rowBtnText, themed.text]}>
                  {starredHosts.has(String(host.invite || '')) ? '★' : '☆'}
                </Text>
              </AppPressable>
              <AppPressable
                style={[styles.rowBtn, themed.panelSoft]}
                onPress={() =>
                  copyInviteIntoDownload(
                    String(host.webSwarmLink || host.invite || ''),
                    `host:${host.invite}`,
                    String(host.invite || ''),
                    { requireWebRtc: true }
                  )
                }
              >
                <Text style={[styles.rowBtnText, themed.text]}>
                  {copyFeedbackKey === `host:${host.invite}` ? '✓' : ACTION_ICON_COPY}
                </Text>
              </AppPressable>
              <AppPressable
                style={[styles.rowBtn, themed.panelSoft, isStopping && styles.rowBtnDisabled]}
                onPress={() => stopActiveHost(host.invite)}
                disabled={isStopping}
              >
                {isStopping ? (
                  <ActivityIndicator size='small' color={theme.danger} />
                ) : (
                  <Text style={[styles.rowBtnText, themed.text, styles.rowDeleteText]}>
                    {ACTION_ICON_STOP}
                  </Text>
                )}
              </AppPressable>
            </View>
          </View>
          <View style={[styles.hostCard, themed.panel]}>
            <View style={[styles.bulkBar, themed.panel]}>
              <Text style={[styles.bulkText, themed.muted]}>
                {hostDetailSourceRefs.length} source{hostDetailSourceRefs.length === 1 ? '' : 's'}
              </Text>
              <AppPressable
                style={[styles.rowBtn, themed.panelSoft]}
                onPress={() => void addHostDetailFiles()}
              >
                <Ionicons name='add-outline' size={16} color={theme.text} />
              </AppPressable>
              <AppPressable
                style={[styles.rowBtn, themed.panelSoft]}
                onPress={removeSelectedHostDetailRefs}
                disabled={!hostDetailSelectedRefs.size}
              >
                {renderDesktopTrashIcon()}
              </AppPressable>
              <AppPressable
                style={[
                  styles.rowBtn,
                  themed.panelSoft,
                  hostDetailApplying && styles.rowBtnDisabled
                ]}
                onPress={() => void applyHostDetailChanges()}
                disabled={hostDetailApplying}
              >
                {hostDetailApplying ? (
                  <ActivityIndicator size='small' color={theme.accent} />
                ) : (
                  <Ionicons name='checkmark-outline' size={16} color={theme.text} />
                )}
              </AppPressable>
            </View>
            {hostDetailSourceRefs.length === 0 ? (
              <Text style={[styles.muted, themed.muted]}>
                No editable source paths saved yet. Add files to continue editing this host.
              </Text>
            ) : (
              hostDetailSourceRefs.map((ref) => {
                const refId = String(ref?.id || '')
                const selected = hostDetailSelectedRefs.has(refId)
                const refName = String(ref?.name || ref?.path || '')
                const refMime = guessMime(refName)
                const refPreviewPath = String(ref?.path || '').trim()
                const showRefImage = refMime.startsWith('image/') && Boolean(refPreviewPath)
                return (
                  <View
                    key={refId}
                    style={[
                      styles.hostRefRow,
                      themed.panelSoft,
                      selected && { borderColor: theme.accent }
                    ]}
                  >
                    <AppPressable
                      style={styles.previewBox}
                      onPress={() => void openHostSourcePreview(ref)}
                    >
                      {showRefImage ? (
                        <Image source={{ uri: refPreviewPath }} style={styles.previewImage} />
                      ) : (
                        <Text style={styles.previewText}>
                          {fileExt(refName).toUpperCase() || 'FILE'}
                        </Text>
                      )}
                    </AppPressable>
                    <AppPressable
                      onPress={() => toggleHostDetailRefSelect(refId)}
                      style={styles.hostRefMetaTouch}
                    >
                      <Text style={[styles.hostRefTitle, themed.text]} numberOfLines={1}>
                        {String(ref?.name || 'Source')}
                      </Text>
                      <Text style={[styles.hostRefPath, themed.muted]} numberOfLines={2}>
                        {String(ref?.path || '')}
                      </Text>
                      <Text style={[styles.hostRefPath, themed.muted]}>
                        {formatBytes(Number(ref?.byteLength || 0))}
                      </Text>
                    </AppPressable>
                  </View>
                )
              })
            )}
          </View>
        </View>
      )
    }

    const activeInvites = new Set(activeHosts.map((host) => String(host.invite || '')))
    const activeTransferIds = new Set(activeHosts.map((host) => String(host.transferId || '')))
    const mergedHostHistory = mergeHostHistory(
      hostHistory,
      history.filter((item) => item.type === 'upload')
    )
    const hostHistoryRows = mergedHostHistory
      .filter((item) => !hostHistoryRemoved.has(historyEntryKey(item)))
      .filter((item) => {
        const invite = String(item.invite || '')
        const transferId = String(item.transferId || item.id || '')
        if (invite && activeInvites.has(invite)) return false
        if (transferId && activeTransferIds.has(transferId)) return false
        return true
      })
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 15)

    return (
      <View style={styles.hostSection}>
        <View style={[styles.sectionBar, themed.panelSoft]}>
          <View style={styles.sectionBarLeft}>
            <Ionicons name='person-outline' size={20} color={theme.text} />
            <Text style={[styles.sectionBarCount, themed.muted]}>{hostPeerRows.length}</Text>
          </View>
        </View>
        {hostPeerRows.length ? (
          hostPeerRows.slice(0, 8).map((row) => {
            const progress = Math.max(
              0,
              Math.min(100, Math.round(Number(row?.progress || 0) * 100))
            )
            const statusText = String(row?.status || '').toLowerCase()
            const isComplete = statusText === 'completed'
            const isJoined = statusText === 'joined'
            const isDownloading = statusText === 'downloading'
            return (
              <View
                key={String(row?.id || Math.random())}
                style={[styles.hostCard, themed.panel, styles.peerCard]}
              >
                <View style={styles.peerRow}>
                  <View style={styles.peerRowMain}>
                    <Text style={[styles.fileName, themed.text]}>
                      {formatPeerLabel(String(row?.peerName || ''), String(row?.peerHex4 || ''))}
                    </Text>
                    <Text style={[styles.fileMeta, themed.muted]}>
                      {String(row?.sessionName || 'Host Session')}
                    </Text>
                    {!isJoined ? (
                      <View style={styles.progressTrack}>
                        <View style={[styles.progressFill, { width: `${progress}%` }]} />
                      </View>
                    ) : null}
                  </View>
                  <Text style={[styles.fileMeta, isComplete ? themed.accentText : themed.muted]}>
                    {isJoined
                      ? 'Joined'
                      : isComplete
                        ? 'Downloaded'
                        : isDownloading
                          ? 'Downloading'
                          : `${progress}%`}
                  </Text>
                </View>
              </View>
            )
          })
        ) : (
          <Text style={[styles.muted, themed.muted]}>No peers connected</Text>
        )}

        <View style={[styles.sectionBar, themed.panelSoft]}>
          <View style={styles.sectionBarLeft}>
            <Ionicons name='git-network-outline' size={20} color={theme.text} />
            <Text style={[styles.sectionBarCount, themed.muted]}>{activeHosts.length}</Text>
          </View>
          <View style={styles.hostSectionActions}>
            <AppPressable
              style={[styles.rowBtn, themed.panelSoft]}
              onPress={toggleSelectAllActiveHosts}
              accessibilityLabel='Select all active hosts'
            >
              <Ionicons
                name={
                  activeHosts.length > 0 && selectedActiveHosts.size === activeHosts.length
                    ? 'checkbox-outline'
                    : 'square-outline'
                }
                size={17}
                color={theme.text}
              />
            </AppPressable>
            <AppPressable
              style={[
                styles.rowBtn,
                themed.panelSoft,
                stoppingSelectedHosts && styles.rowBtnDisabled
              ]}
              onPress={() => void stopSelectedActiveHosts()}
            >
              {stoppingSelectedHosts ? (
                <ActivityIndicator size='small' color={theme.danger} />
              ) : (
                <Text style={[styles.rowBtnText, themed.text, styles.rowDeleteText]}>
                  {ACTION_ICON_STOP}
                </Text>
              )}
            </AppPressable>
          </View>
        </View>
        {activeHosts.length === 0 ? (
          <Text style={[styles.muted, themed.muted]}>No active host sessions.</Text>
        ) : (
          activeHosts.map((host) => {
            const inviteKey = String(host.invite || '').trim()
            const selected = inviteKey ? selectedActiveHosts.has(inviteKey) : false
            const label = parseHostSessionLabel(
              host.sessionLabel || host.sessionName || 'Host Session'
            )
            const dateLine = formatHostSessionDateLine(host.createdAt, label.embeddedDateTime)
            return (
              <View
                key={host.invite}
                onLayout={(event) => {
                  const inviteKey = String(host.invite || '').trim()
                  if (!inviteKey) return
                  hostCardYByInviteRef.current.set(inviteKey, event.nativeEvent.layout.y)
                }}
                style={[
                  styles.hostCard,
                  themed.panel,
                  highlightedHostInvite === String(host.invite || '').trim() && styles.hostCardGlow
                ]}
              >
                <View style={styles.hostCardHead}>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() => toggleSelectActiveHost(host.invite)}
                  >
                    <Text style={[styles.rowBtnText, themed.text]}>{selected ? '☑' : '☐'}</Text>
                  </AppPressable>
                  <AppPressable
                    style={styles.hostCardTitleWrap}
                    onPress={() => openHostDetail(host.invite)}
                  >
                    <Text style={[styles.hostCardTitle, themed.text]}>
                      {label.title}
                      {label.hash ? (
                        <Text style={styles.hostHashInline}> ({label.hash})</Text>
                      ) : null}
                    </Text>
                    <Text style={[styles.hostMetaDate, themed.muted]}>{dateLine || '—'}</Text>
                    <Text style={[styles.hostMetaSize, themed.muted]}>
                      {formatBytes(Number(host.totalBytes || 0))}{' '}
                      {host.fileCount ? `• ${host.fileCount} files` : ''} •{' '}
                      {String(host.hostMode || 'raw').toUpperCase()}
                    </Text>
                  </AppPressable>
                </View>
                <View style={styles.hostCardActions}>
                  {(() => {
                    const stopKey = String(host.invite || '').trim()
                    const isStopping = stopKey ? stoppingInvites.has(stopKey) : false
                    return (
                      <>
                        <AppPressable
                          style={[styles.rowBtn, themed.panelSoft]}
                          onPress={() =>
                            openSessionNameEditor({
                              invite: String(host.invite || ''),
                              current: label.title
                            })
                          }
                        >
                          <Ionicons name='pencil-outline' size={16} color={theme.text} />
                        </AppPressable>
                        <AppPressable
                          style={[styles.rowBtn, themed.panelSoft]}
                          onPress={() =>
                            copyInviteIntoDownload(
                              String(host.webSwarmLink || host.invite || ''),
                              `host:${host.invite}`,
                              String(host.invite || ''),
                              { requireWebRtc: true }
                            )
                          }
                        >
                          <Text style={[styles.rowBtnText, themed.text]}>
                            {copyFeedbackKey === `host:${host.invite}` ? '✓' : ACTION_ICON_COPY}
                          </Text>
                        </AppPressable>
                        <AppPressable
                          style={[styles.rowBtn, themed.panelSoft]}
                          onPress={() => toggleStarHostInvite(host.invite)}
                        >
                          <Text style={[styles.rowBtnText, themed.text]}>
                            {starredHosts.has(String(host.invite || '')) ? '★' : '☆'}
                          </Text>
                        </AppPressable>
                        <AppPressable
                          style={[
                            styles.rowBtn,
                            themed.panelSoft,
                            isStopping && styles.rowBtnDisabled
                          ]}
                          onPress={() => stopActiveHost(host.invite)}
                          disabled={isStopping}
                        >
                          {isStopping ? (
                            <ActivityIndicator size='small' color={theme.danger} />
                          ) : (
                            <Text style={[styles.rowBtnText, themed.text, styles.rowDeleteText]}>
                              {ACTION_ICON_STOP}
                            </Text>
                          )}
                        </AppPressable>
                      </>
                    )
                  })()}
                </View>
              </View>
            )
          })
        )}

        <View style={[styles.sectionBar, themed.panelSoft]}>
          <View style={styles.sectionBarLeft}>
            <Ionicons name='star-outline' size={20} color={theme.text} />
            <Text style={[styles.sectionBarCount, themed.muted]}>
              {Array.from(starredHosts).length}
            </Text>
          </View>
        </View>
        {Array.from(starredHosts).length === 0 ? (
          <Text style={[styles.muted, themed.muted]}>No starred hosts.</Text>
        ) : (
          Array.from(starredHosts).map((invite) => {
            const activeHost = activeHosts.find((host) => String(host.invite || '') === invite)
            const historyItem = mergedHostHistory.find(
              (item) => String(item?.invite || '') === invite
            )
            const canStop = Boolean(activeHost)
            const canRehost =
              !canStop && Boolean(historyItem && String(historyEntryKey(historyItem)).trim())
            const historyKey = historyItem ? historyEntryKey(historyItem) : ''
            const isRehosting = historyKey ? rehostingHistoryKeys.has(historyKey) : false
            const isStopping = canStop && stoppingInvites.has(String(invite || '').trim())
            const label = parseHostSessionLabel(
              activeHost?.sessionLabel ||
                historyItem?.sessionLabel ||
                historyItem?.sessionName ||
                'Starred host'
            )
            const dateLine = formatHostSessionDateLine(
              activeHost?.createdAt || historyItem?.createdAt,
              label.embeddedDateTime
            )
            const totalBytes = Number(activeHost?.totalBytes || historyItem?.totalBytes || 0)

            return (
              <View key={`starred:${invite}`} style={[styles.hostCard, themed.panel]}>
                <View style={styles.hostCardHead}>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() => toggleStarHostInvite(invite)}
                  >
                    <Text style={[styles.rowBtnText, themed.text]}>
                      {starredHosts.has(String(invite || '')) ? '☑' : '☐'}
                    </Text>
                  </AppPressable>
                  <AppPressable
                    style={styles.hostCardTitleWrap}
                    onPress={() =>
                      openSessionNameEditor({
                        invite,
                        historyKey,
                        current: label.title
                      })
                    }
                  >
                    <Text style={[styles.hostCardTitle, themed.text]}>
                      {label.title}
                      {label.hash ? (
                        <Text style={styles.hostHashInline}> ({label.hash})</Text>
                      ) : null}
                    </Text>
                    <Text style={[styles.hostMetaDate, themed.muted]}>{dateLine || '—'}</Text>
                    <Text style={[styles.hostMetaSize, themed.muted]}>
                      {canStop
                        ? `${formatBytes(totalBytes)} • ${activeHost?.fileCount || 0} files`
                        : `${formatBytes(totalBytes)}${historyItem?.fileCount ? ` • ${historyItem.fileCount} files` : ' • Not active'}`}
                    </Text>
                  </AppPressable>
                </View>
                <View style={styles.hostCardActions}>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() =>
                      openSessionNameEditor({
                        invite,
                        historyKey,
                        current: label.title
                      })
                    }
                  >
                    <Ionicons name='pencil-outline' size={16} color={theme.text} />
                  </AppPressable>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() =>
                      copyInviteIntoDownload(
                        String(activeHost?.webSwarmLink || invite || ''),
                        `starred:${invite}`,
                        String(invite || ''),
                        { requireWebRtc: true }
                      )
                    }
                  >
                    <Text style={[styles.rowBtnText, themed.text]}>
                      {copyFeedbackKey === `starred:${invite}` ? '✓' : ACTION_ICON_COPY}
                    </Text>
                  </AppPressable>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() => toggleStarHostInvite(invite)}
                  >
                    <Ionicons
                      name={starredHosts.has(String(invite || '')) ? 'star' : 'star-outline'}
                      size={16}
                      color={theme.text}
                    />
                  </AppPressable>
                  {canStop ? (
                    <AppPressable
                      style={[styles.rowBtn, themed.panelSoft, isStopping && styles.rowBtnDisabled]}
                      onPress={() => void stopActiveHost(invite)}
                      disabled={isStopping}
                    >
                      {isStopping ? (
                        <ActivityIndicator size='small' color={theme.danger} />
                      ) : (
                        <Text style={[styles.rowBtnText, themed.text, styles.rowDeleteText]}>
                          {ACTION_ICON_STOP}
                        </Text>
                      )}
                    </AppPressable>
                  ) : canRehost ? (
                    <AppPressable
                      style={[
                        styles.rowBtn,
                        themed.panelSoft,
                        isRehosting && styles.rowBtnDisabled
                      ]}
                      onPress={() => void restartHostFromHistory(historyItem)}
                      disabled={isRehosting}
                    >
                      {isRehosting ? (
                        <ActivityIndicator size='small' color={theme.accent} />
                      ) : (
                        <Text style={[styles.rowBtnText, themed.text]}>{ACTION_ICON_PLAY}</Text>
                      )}
                    </AppPressable>
                  ) : (
                    <View style={[styles.rowBtn, themed.panelSoft, styles.rowBtnDisabled]} />
                  )}
                </View>
              </View>
            )
          })
        )}

        <View style={[styles.sectionBar, themed.panelSoft]}>
          <View style={styles.sectionBarLeft}>
            <Ionicons name='time-outline' size={20} color={theme.text} />
            <Text style={[styles.sectionBarCount, themed.muted]}>{hostHistoryRows.length}</Text>
          </View>
          <View style={styles.hostSectionActions}>
            <AppPressable
              style={[styles.rowBtn, themed.panelSoft]}
              onPress={() => toggleSelectAllHistoryHosts(hostHistoryRows)}
              accessibilityLabel='Select all history items'
            >
              <Ionicons
                name={
                  hostHistoryRows.length > 0 &&
                  hostHistoryRows.every((item) => selectedHostHistory.has(historyEntryKey(item)))
                    ? 'checkbox-outline'
                    : 'square-outline'
                }
                size={17}
                color={theme.text}
              />
            </AppPressable>
            <AppPressable
              style={[styles.rowBtn, themed.panelSoft, hostingBusy && styles.rowBtnDisabled]}
              onPress={() => void startSelectedHistoryHosts(hostHistoryRows)}
            >
              {hostingBusy ? (
                <ActivityIndicator size='small' color={theme.accent} />
              ) : (
                <Text style={[styles.rowBtnText, themed.text]}>{ACTION_ICON_PLAY}</Text>
              )}
            </AppPressable>
            <AppPressable
              style={[styles.rowBtn, themed.panelSoft]}
              onPress={() => {
                const picked = hostHistoryRows.filter((item) =>
                  selectedHostHistory.has(historyEntryKey(item))
                )
                if (!picked.length) return
                Alert.alert(
                  'Remove selected history?',
                  `Remove ${picked.length} item(s) from host history?`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Remove',
                      style: 'destructive',
                      onPress: () => removeHistoryItems(picked)
                    }
                  ]
                )
              }}
            >
              {renderDesktopTrashIcon()}
            </AppPressable>
          </View>
        </View>
        {hostHistoryRows.length === 0 ? (
          <Text style={[styles.muted, themed.muted]}>No host history yet.</Text>
        ) : (
          hostHistoryRows.map((item) => {
            const historyKey = historyEntryKey(item)
            const isRehosting = historyKey ? rehostingHistoryKeys.has(historyKey) : false
            const label = parseHostSessionLabel(
              item.sessionLabel || item.sessionName || item.invite || 'Upload history'
            )
            const dateLine = formatHostSessionDateLine(item.createdAt, label.embeddedDateTime)
            return (
              <View
                key={historyKey || String(item.id || item.transferId || Math.random())}
                style={[styles.hostCard, themed.panel]}
              >
                <View style={styles.hostCardHead}>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() => toggleSelectHostHistory(item)}
                  >
                    <Text style={[styles.rowBtnText, themed.text]}>
                      {selectedHostHistory.has(historyKey) ? '☑' : '☐'}
                    </Text>
                  </AppPressable>
                  <AppPressable
                    style={styles.hostCardTitleWrap}
                    onPress={() =>
                      openSessionNameEditor({
                        invite: String(item?.invite || ''),
                        historyKey,
                        current: label.title
                      })
                    }
                  >
                    <Text style={[styles.hostCardTitle, themed.text]}>
                      {label.title}
                      {label.hash ? (
                        <Text style={styles.hostHashInline}> ({label.hash})</Text>
                      ) : null}
                    </Text>
                    <Text style={[styles.hostMetaDate, themed.muted]}>{dateLine || '—'}</Text>
                    <Text style={[styles.hostMetaSize, themed.muted]}>
                      {formatBytes(Number(item.totalBytes || 0))}{' '}
                      {item.fileCount ? `• ${item.fileCount} files` : ''}
                    </Text>
                  </AppPressable>
                </View>
                <View style={styles.hostCardActions}>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() =>
                      openSessionNameEditor({
                        invite: String(item?.invite || ''),
                        historyKey,
                        current: label.title
                      })
                    }
                  >
                    <Ionicons name='pencil-outline' size={16} color={theme.text} />
                  </AppPressable>
                  {item.invite ? (
                    <AppPressable
                      style={[styles.rowBtn, themed.panelSoft]}
                      onPress={() =>
                        copyInviteIntoDownload(
                          item.invite,
                          `history:${historyEntryKey(item)}`,
                          String(item.invite || '')
                        )
                      }
                    >
                      <Text style={[styles.rowBtnText, themed.text]}>
                        {copyFeedbackKey === `history:${historyEntryKey(item)}`
                          ? '✓'
                          : ACTION_ICON_COPY}
                      </Text>
                    </AppPressable>
                  ) : (
                    <View style={[styles.rowBtn, themed.panelSoft, styles.rowBtnDisabled]} />
                  )}
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() => toggleStarHostInvite(String(item?.invite || ''))}
                    disabled={!String(item?.invite || '').trim()}
                  >
                    <Ionicons
                      name={starredHosts.has(String(item?.invite || '')) ? 'star' : 'star-outline'}
                      size={16}
                      color={theme.text}
                    />
                  </AppPressable>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft, isRehosting && styles.rowBtnDisabled]}
                    onPress={() => void restartHostFromHistory(item)}
                    disabled={isRehosting}
                  >
                    {isRehosting ? (
                      <ActivityIndicator size='small' color={theme.accent} />
                    ) : (
                      <Text style={[styles.rowBtnText, themed.text]}>{ACTION_ICON_PLAY}</Text>
                    )}
                  </AppPressable>
                  <AppPressable
                    style={[styles.rowBtn, themed.panelSoft]}
                    onPress={() =>
                      Alert.alert('Remove history?', 'Remove this item from host history?', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () => removeHistoryItems([item])
                        }
                      ])
                    }
                  >
                    {renderDesktopTrashIcon()}
                  </AppPressable>
                </View>
              </View>
            )
          })
        )}
      </View>
    )
  }

  const renderInviteList = () => {
    return (
      <View style={styles.hostSection}>
        <View style={styles.hostDetailHead}>
          <AppPressable
            style={styles.backArrowBtn}
            onPress={() => {
              setInviteMode(false)
              setInviteEntries([])
              setInviteRenderCount(80)
              setInviteSelected(new Set())
              setInvitePreviewThumbs({})
              setInvitePreviewFull({})
              setInvitePreviewLoading(new Set())
              invitePreviewLoadRef.current = new Set()
            }}
          >
            <Text style={[styles.backArrowText, themed.text]}>←</Text>
          </AppPressable>
          <Text style={styles.hostDetailTitle}>View drive</Text>
        </View>
        {inviteEntries.slice(0, inviteRenderCount).map((entry, i) => {
          const key = String(entry.drivePath || entry.name)
          const selectedRow = inviteSelected.has(key)
          const thumbData = String(invitePreviewThumbs[key] || '')
          const thumbLoading = invitePreviewLoading.has(key)
          const canPreview = isInviteImageEntry(entry)
          return (
            <View
              key={`${key}:${i}`}
              style={[styles.fileRow, themed.panel, selectedRow && { borderColor: theme.accent }]}
            >
              <AppPressable
                style={styles.previewBox}
                onPress={() => void openInviteEntryPreview(entry)}
                disabled={!canPreview && !thumbData}
              >
                {thumbData ? (
                  <Image
                    source={{
                      uri: `data:${String(entry.mimeType || guessMime(entry.name || 'file'))};base64,${thumbData}`
                    }}
                    style={styles.previewImage}
                  />
                ) : thumbLoading ? (
                  <View
                    style={[styles.skeletonBlock, themed.panelSoft, styles.invitePreviewSkeleton]}
                  >
                    <Animated.View
                      pointerEvents='none'
                      style={[
                        styles.skeletonShimmerOverlay,
                        {
                          transform: [
                            {
                              translateX: skeletonShimmer.interpolate({
                                inputRange: [0, 1],
                                outputRange: [-140, 140]
                              })
                            }
                          ]
                        }
                      ]}
                    />
                  </View>
                ) : (
                  <Text style={styles.previewText}>
                    {fileExt(entry.name || '').toUpperCase() || 'FILE'}
                  </Text>
                )}
              </AppPressable>
              <AppPressable onPress={() => toggleInviteSelect(entry)} style={styles.fileMetaTouch}>
                <Text style={[styles.fileName, themed.text]}>{entry.name || `File ${i + 1}`}</Text>
                <Text style={[styles.fileSub, themed.muted]}>
                  {formatBytes(Number(entry.byteLength || 0))}
                </Text>
              </AppPressable>
              <AppPressable
                style={[
                  styles.rowBtn,
                  themed.panelSoft,
                  inviteDownloadBusy && styles.rowBtnDisabled
                ]}
                onPress={async () => {
                  setInviteSelected(new Set([key]))
                  await downloadInviteSelected()
                }}
                disabled={inviteDownloadBusy}
              >
                {inviteDownloadBusy ? (
                  <ActivityIndicator size='small' color={theme.accent} />
                ) : (
                  <Text style={[styles.rowBtnText, themed.text]}>↓</Text>
                )}
              </AppPressable>
            </View>
          )
        })}
        {inviteRenderCount < inviteEntries.length ? (
          <View style={styles.inviteLoadMoreWrap}>
            <AppPressable
              style={[
                styles.secondaryBtn,
                themed.panelSoft,
                inviteDownloadBusy && styles.rowBtnDisabled
              ]}
              onPress={() =>
                setInviteRenderCount((prev) => Math.min(inviteEntries.length, prev + 120))
              }
              disabled={inviteDownloadBusy}
            >
              <Text style={[styles.secondaryBtnText, themed.text]}>
                Load more ({inviteRenderCount}/{inviteEntries.length})
              </Text>
            </AppPressable>
          </View>
        ) : null}
      </View>
    )
  }

  const renderFileList = () => {
    if (!visibleFiles.length) {
      return (
        <AppPressable style={[styles.emptyFileDropzone, themed.panel]} onPress={onAddSource}>
          <View style={[styles.emptyFileIconWrap, themed.panelSoft]}>
            <Ionicons name='document-outline' size={28} color={theme.muted} />
          </View>
          <Text style={[styles.emptyFileDropzoneTitle, themed.text]}>Add files</Text>
          <Text style={[styles.emptyFileDropzoneSub, themed.muted]}>
            Tap to choose files for hosting
          </Text>
        </AppPressable>
      )
    }

    return visibleFiles.map((item) => {
      const isSelected = selected.has(item.id)
      const resolvedMimeType = String(item.mimeType || guessMime(item.name || ''))
      const localPath = String(item.path || '')
      const imageUri = item.dataBase64
        ? `data:${resolvedMimeType || 'image/*'};base64,${item.dataBase64}`
        : localPath
      const isImage = resolvedMimeType.startsWith('image/') && Boolean(imageUri)
      const coverArt = String(item.coverArtDataUrl || '').trim()
      const isVideo = resolvedMimeType.startsWith('video/')
      return (
        <View
          key={item.id}
          style={[styles.fileRow, themed.panel, isSelected && { borderColor: theme.accent }]}
        >
          <AppPressable
            style={styles.previewBox}
            onPress={() => {
              setPreviewFile({
                name: item.name,
                mimeType: resolvedMimeType,
                dataBase64: item.dataBase64,
                uri: localPath
              })
              previewTranslateY.setValue(0)
            }}
          >
            {isImage ? (
              <Image source={{ uri: imageUri }} style={styles.previewImage} />
            ) : coverArt ? (
              <Image source={{ uri: coverArt }} style={styles.previewImage} />
            ) : (
              <Text style={styles.previewText}>
                {isVideo ? '▶' : fileExt(item.name).toUpperCase() || 'FILE'}
              </Text>
            )}
          </AppPressable>
          <AppPressable onPress={() => toggleSelect(item.id)} style={styles.fileMetaTouch}>
            <Text style={[styles.fileName, themed.text]}>{item.name}</Text>
            <Text style={[styles.fileSub, themed.muted]}>
              {formatBytes(item.byteLength)} • {formatDate(item.updatedAt)} • {item.source}
            </Text>
          </AppPressable>
          <View style={styles.fileActions}>
            <AppPressable
              onPress={() => {
                Alert.alert(
                  'Remove file?',
                  'This removes the file from app history and clears its saved source path.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => toggleDelete(item.id) }
                  ]
                )
              }}
              style={[styles.rowBtn, themed.panelSoft]}
            >
              <Text style={[styles.rowBtnText, themed.text]}>✕</Text>
            </AppPressable>
          </View>
        </View>
      )
    })
  }

  const renderStartupContainerSkeleton = (variant: 'upload' | 'download') => (
    <View style={styles.skeletonListWrap}>
      <View
        style={[
          styles.skeletonContainerCard,
          themed.panel,
          variant === 'upload' ? styles.skeletonUploadContainer : styles.skeletonDownloadContainer
        ]}
      >
        <View style={[styles.skeletonBlock, themed.panelSoft]} />
        <Animated.View
          pointerEvents='none'
          style={[
            styles.skeletonShimmerOverlay,
            {
              transform: [
                {
                  translateX: skeletonShimmer.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-320, 320]
                  })
                }
              ]
            }
          ]}
        />
      </View>
    </View>
  )

  const renderDesktopTrashIcon = () => (
    <View style={styles.miniTrash}>
      <View style={[styles.miniTrashLid, styles.rowDeleteTone]} />
      <View style={[styles.miniTrashBody, styles.rowDeleteToneBorder]}>
        <View style={[styles.miniTrashLine, styles.rowDeleteTone]} />
        <View style={[styles.miniTrashLine, styles.rowDeleteTone]} />
      </View>
    </View>
  )

  const renderOptionsView = () => (
    <View style={styles.hostSection}>
      <View style={styles.hostDetailHead}>
        <Text style={[styles.viewTitle, themed.text]}>Options</Text>
      </View>

      <View style={[styles.hostCard, themed.panel]}>
        <Text style={[styles.optionItemTitle, themed.text]}>Theme</Text>
        <View style={styles.optionThemeRow}>
          {(['system', 'dark', 'light'] as ThemeMode[]).map((mode) => (
            <AppPressable
              key={mode}
              style={[
                styles.optionThemeBtn,
                themed.panelSoft,
                mode === themeMode && styles.mainTabBtnActive
              ]}
              onPress={() => setThemeMode(mode)}
            >
              <Text
                style={[
                  styles.optionThemeBtnText,
                  themed.muted,
                  mode === themeMode && themed.accentText
                ]}
              >
                {themeModeMeta[mode].label}
              </Text>
            </AppPressable>
          ))}
        </View>
      </View>
    </View>
  )

  if (!metadataLoaded) {
    return (
      <SafeAreaView style={[styles.container, themed.container]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={styles.onboardingShell}>
          <View style={[styles.onboardingCard, themed.panel]}>
            <Text style={[styles.onboardingTitle, themed.text]}>Loading PearDrop…</Text>
            <Text style={[styles.onboardingCopy, themed.muted]}>Checking your saved setup.</Text>
            <View style={styles.onboardingSpinnerRow}>
              <ActivityIndicator size='small' color={theme.accent} />
            </View>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  if (!onboardingDone) {
    return (
      <SafeAreaView style={[styles.container, themed.container]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={styles.onboardingShell}>
          <View style={[styles.onboardingCard, themed.panel]}>
            <Text style={[styles.onboardingTitle, themed.text]}>Welcome to PearDrop</Text>
            <Text style={[styles.onboardingCopy, themed.muted]}>
              Choose your theme and set your peer name.
            </Text>
            <View style={styles.onboardingThemeRow}>
              {(['system', 'dark', 'light'] as ThemeMode[]).map((mode) => (
                <AppPressable
                  key={mode}
                  style={[
                    styles.onboardingThemeBtn,
                    themed.panelSoft,
                    mode === themeMode && styles.mainTabBtnActive
                  ]}
                  onPress={() => setThemeMode(mode)}
                >
                  <Text style={[styles.mainTabBtnText, mode === themeMode && themed.accentText]}>
                    {mode[0].toUpperCase() + mode.slice(1)}
                  </Text>
                </AppPressable>
              ))}
            </View>
            <TextInput
              value={peerName}
              onChangeText={setPeerName}
              placeholder='Enter your name'
              placeholderTextColor={theme.inputPlaceholder}
              style={[styles.onboardingInput, themed.panelSoft, themed.text]}
            />
            <AppPressable
              style={[
                styles.primaryBtn,
                themed.accentBg,
                styles.onboardingContinueBtn,
                !String(peerName || '').trim() && styles.rowBtnDisabled
              ]}
              onPress={() => {
                if (!String(peerName || '').trim()) return
                setOnboardingDone(true)
              }}
              disabled={!String(peerName || '').trim()}
            >
              <Text style={styles.primaryBtnText}>Continue</Text>
            </AppPressable>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={[styles.container, themed.container]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      <View style={[styles.topHeader, themed.container]}>
        {optionsViewOpen ? (
          <AppPressable style={styles.backArrowBtn} onPress={() => setOptionsViewOpen(false)}>
            <Text style={[styles.backArrowText, themed.text]}>←</Text>
          </AppPressable>
        ) : (
          <AppPressable style={styles.settingsBtn} onPress={() => setOptionsViewOpen(true)}>
            <Text style={[styles.settingsBtnText, { color: theme.accent }]}>⚙︎</Text>
          </AppPressable>
        )}
      </View>

      {!optionsViewOpen ? (
        <View style={styles.mainTabsRow}>
          <AppPressable
            style={[
              styles.mainTabBtn,
              themed.panelSoft,
              mainTab === 'upload' && styles.mainTabBtnActive
            ]}
            onPress={() => setMainTab('upload')}
            accessibilityLabel='Upload'
          >
            <Ionicons
              name='cloud-upload-outline'
              size={18}
              color={mainTab === 'upload' ? theme.accent : theme.text}
            />
          </AppPressable>
          <AppPressable
            style={[
              styles.mainTabBtn,
              themed.panelSoft,
              mainTab === 'download' && styles.mainTabBtnActive
            ]}
            onPress={() => setMainTab('download')}
            accessibilityLabel='Download'
          >
            <Ionicons
              name='cloud-download-outline'
              size={18}
              color={mainTab === 'download' ? theme.accent : theme.text}
            />
          </AppPressable>
        </View>
      ) : null}

      <ScrollView ref={uploadScrollRef} contentContainerStyle={styles.scrollContent}>
        {optionsViewOpen ? (
          renderOptionsView()
        ) : mainTab === 'upload' ? (
          <>
            <View style={styles.inlineActions}>
              <AppPressable
                style={[styles.primaryBtn, themed.accentBg, styles.hostNewActionBtn]}
                onPress={onAddSource}
              >
                <Text style={styles.primaryBtnText}>+</Text>
              </AppPressable>
              <AppPressable
                style={[
                  styles.secondaryBtn,
                  themed.panelSoft,
                  styles.hostNewActionBtn,
                  !visibleFiles.length && styles.rowBtnDisabled
                ]}
                onPress={toggleSelectAllLocalSources}
                disabled={!visibleFiles.length}
                accessibilityLabel='Select all files'
              >
                <Ionicons
                  name={
                    visibleFiles.length > 0 &&
                    visibleFiles.every((item) => selected.has(String(item.id || '')))
                      ? 'checkbox-outline'
                      : 'square-outline'
                  }
                  size={18}
                  color={theme.text}
                />
              </AppPressable>
              <AppPressable
                style={[
                  styles.rowBtn,
                  themed.panelSoft,
                  styles.hostNewActionBtn,
                  !selected.size && styles.rowBtnDisabled
                ]}
                onPress={() => {
                  Alert.alert(
                    'Remove selected?',
                    `Remove ${selected.size} selected source file(s)?`,
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Remove', style: 'destructive', onPress: removeSelectedLocal }
                    ]
                  )
                }}
                disabled={!selected.size}
              >
                {renderDesktopTrashIcon()}
              </AppPressable>
              <AppPressable
                style={[
                  styles.primaryBtn,
                  themed.accentBg,
                  styles.hostNewActionBtn,
                  (hostingBusy ||
                    hostSelectedPending ||
                    hostNameModalVisible ||
                    selected.size === 0) &&
                    styles.rowBtnDisabled
                ]}
                onPress={() =>
                  hostingBusy || hostSelectedPending
                    ? cancelOperationOptimistic(hostOperationIdRef.current, () => {
                        setHostingBusy(false)
                        setHostSelectedPending(false)
                      })
                    : startHostNamePromptForSelected()
                }
                disabled={
                  !hostingBusy &&
                  !hostSelectedPending &&
                  (hostNameModalVisible || selected.size === 0)
                }
                accessibilityLabel='Host selected files'
              >
                {hostingBusy || hostSelectedPending ? (
                  <ActivityIndicator size='small' color='#fff' />
                ) : (
                  <Ionicons name='rocket-outline' size={18} color='#fff' />
                )}
              </AppPressable>
            </View>

            <View style={styles.filesList}>
              {workerBooting ? renderStartupContainerSkeleton('upload') : renderFileList()}
            </View>
            {renderHostContent()}
          </>
        ) : (
          <>
            <View style={styles.inviteInputRow}>
              <TextInput
                value={inviteInput}
                onChangeText={setInviteInput}
                placeholder='Paste peardrops://invite...'
                placeholderTextColor={theme.inputPlaceholder}
                style={[styles.searchInput, themed.searchInput, styles.inviteInputRowField]}
              />
              <AppPressable
                style={[styles.primaryBtn, themed.accentBg, inviteLoading && styles.rowBtnDisabled]}
                onPress={() =>
                  inviteLoading
                    ? cancelOperationOptimistic(inviteLoadOperationIdRef.current, () => {
                        setInviteLoading(false)
                      })
                    : void onDownload()
                }
              >
                {inviteLoading ? (
                  <View style={styles.loadingInline}>
                    <ActivityIndicator size='small' color='#fff' />
                    <Text style={styles.primaryBtnText}>Loading...</Text>
                  </View>
                ) : (
                  <Ionicons name='search-outline' size={18} color='#fff' />
                )}
              </AppPressable>
            </View>
            <View style={styles.inlineActions}>
              {inviteMode ? (
                <AppPressable
                  style={[
                    styles.secondaryBtn,
                    themed.panelSoft,
                    inviteDownloadBusy && styles.rowBtnDisabled
                  ]}
                  onPress={toggleInviteSelectAll}
                  disabled={inviteDownloadBusy || !inviteEntries.length}
                  accessibilityLabel='Select all invite files'
                >
                  <Ionicons
                    name={
                      inviteEntries.length > 0 &&
                      inviteEntries.every((entry) =>
                        inviteSelected.has(String(entry.drivePath || entry.name))
                      )
                        ? 'checkbox-outline'
                        : 'square-outline'
                    }
                    size={18}
                    color={theme.text}
                  />
                </AppPressable>
              ) : null}
              {inviteMode ? (
                <AppPressable
                  style={[
                    styles.secondaryBtn,
                    themed.panelSoft,
                    inviteDownloadBusy && styles.rowBtnDisabled
                  ]}
                  onPress={() =>
                    inviteDownloadBusy
                      ? cancelOperationOptimistic(inviteDownloadOperationIdRef.current, () => {
                          setInviteDownloadBusy(false)
                        })
                      : void downloadInviteSelected()
                  }
                  accessibilityLabel='Download selected invite files'
                >
                  {inviteDownloadBusy ? (
                    <ActivityIndicator size='small' color={theme.accent} />
                  ) : (
                    <Ionicons name='download-outline' size={18} color={theme.text} />
                  )}
                </AppPressable>
              ) : null}
            </View>

            <View style={styles.filesList}>
              {workerBooting ? (
                renderStartupContainerSkeleton('download')
              ) : inviteLoading ? (
                <View style={[styles.inviteLoaderCard, themed.panel]}>
                  <ActivityIndicator size='small' color={theme.accent} />
                  <Text style={[styles.muted, themed.muted]}>Loading drive files...</Text>
                </View>
              ) : inviteMode ? (
                renderInviteList()
              ) : (
                <Text style={[styles.muted, themed.muted]}>
                  View a drive invite to select and download files.
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>

      <Modal
        visible={hostNameModalVisible}
        transparent
        animationType='fade'
        onRequestClose={dismissHostNameModal}
      >
        <View style={styles.folderModalRoot}>
          <AppPressable style={styles.folderModalBackdrop} onPress={dismissHostNameModal} />
          <View style={[styles.folderModalCard, themed.panel]}>
            <Text style={[styles.folderModalTitle, themed.text]}>Host session name</Text>
            <Text style={[styles.muted, themed.muted]}>
              Final session label: name + date + 4-char random hex.
            </Text>
            <TextInput
              value={hostNameDraft}
              onChangeText={setHostNameDraft}
              placeholder='Host Session'
              style={[styles.folderInput, themed.panelSoft, themed.text]}
            />
            <View style={styles.folderOptionsScroll}>
              <AppPressable
                style={[
                  styles.folderOptionBtn,
                  themed.panelSoft,
                  hostPackagingMode === 'zip' && themed.accentBg
                ]}
                onPress={() => setHostPackagingMode('zip')}
              >
                <Text
                  style={[
                    styles.folderOptionText,
                    hostPackagingMode === 'zip' && styles.mainTabBtnTextActive,
                    themed.text
                  ]}
                >
                  Host mode: Single ZIP package (default)
                </Text>
              </AppPressable>
              <AppPressable
                style={[
                  styles.folderOptionBtn,
                  themed.panelSoft,
                  hostPackagingMode === 'raw' && themed.accentBg
                ]}
                onPress={() => setHostPackagingMode('raw')}
              >
                <Text
                  style={[
                    styles.folderOptionText,
                    hostPackagingMode === 'raw' && styles.mainTabBtnTextActive,
                    themed.text
                  ]}
                >
                  Host mode: Raw files
                </Text>
              </AppPressable>
            </View>
            <View style={styles.folderModalActions}>
              <AppPressable
                style={[styles.rowBtn, themed.panelSoft]}
                onPress={dismissHostNameModal}
              >
                <Ionicons name='close-outline' size={16} color={theme.text} />
              </AppPressable>
              <AppPressable
                style={[styles.primaryBtn, themed.accentBg]}
                onPress={() => void submitHostNameModal()}
              >
                <Ionicons name='rocket-outline' size={18} color='#fff' />
              </AppPressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={sessionNameEditVisible}
        transparent
        animationType='fade'
        onRequestClose={closeSessionNameEditor}
      >
        <View style={styles.folderModalRoot}>
          <AppPressable style={styles.folderModalBackdrop} onPress={closeSessionNameEditor} />
          <View style={[styles.folderModalCard, themed.panel]}>
            <Text style={[styles.folderModalTitle, themed.text]}>Edit session name</Text>
            <TextInput
              value={sessionNameEditDraft}
              onChangeText={setSessionNameEditDraft}
              placeholder='Host Session'
              style={[styles.folderInput, themed.panelSoft, themed.text]}
            />
            <View style={styles.folderModalActions}>
              <AppPressable
                style={[styles.rowBtn, themed.panelSoft]}
                onPress={closeSessionNameEditor}
              >
                <Ionicons name='close-outline' size={16} color={theme.text} />
              </AppPressable>
              <AppPressable
                style={[styles.primaryBtn, themed.accentBg]}
                onPress={applySessionNameEdit}
              >
                <Ionicons name='checkmark-outline' size={18} color='#fff' />
              </AppPressable>
            </View>
          </View>
        </View>
      </Modal>

      <PreviewModal
        file={previewFile}
        translateY={previewTranslateY}
        onClose={() => {
          Animated.timing(previewTranslateY, {
            toValue: 700,
            duration: 160,
            useNativeDriver: true
          }).start(() => {
            previewTranslateY.setValue(0)
            setPreviewFile(null)
          })
        }}
      />
    </SafeAreaView>
  )
}

function PreviewModal({
  file,
  translateY,
  onClose
}: {
  file: PreviewItem | null
  translateY: Animated.Value
  onClose: () => void
}) {
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 6,
        onPanResponderMove: (_, gesture) => {
          if (gesture.dy > 0) translateY.setValue(gesture.dy)
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 130) onClose()
          else {
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: true
            }).start()
          }
        }
      }),
    [onClose, translateY]
  )

  const visible = Boolean(file)
  const mime = String(file?.mimeType || '').toLowerCase()
  const isImageMime = mime.startsWith('image/')
  const isVideo = mime.startsWith('video/')
  const imageUri = file?.dataBase64
    ? `data:${file?.mimeType || 'image/*'};base64,${file.dataBase64}`
    : String(file?.uri || '')
  const isImage = isImageMime && Boolean(imageUri)

  return (
    <Modal visible={visible} transparent animationType='fade' onRequestClose={onClose}>
      <View style={styles.previewModalRoot}>
        <AppPressable style={styles.previewBackdrop} onPress={onClose} />
        <Animated.View
          style={[styles.previewSheet, { transform: [{ translateY }] }]}
          {...panResponder.panHandlers}
        >
          <View style={styles.previewSheetHead}>
            <Text style={styles.previewSheetTitle}>{file?.name || ''}</Text>
            <AppPressable onPress={onClose} style={styles.previewCloseBtn}>
              <Text style={styles.previewCloseText}>✕</Text>
            </AppPressable>
          </View>
          <View style={styles.previewSheetBody}>
            {isImage ? (
              <Image
                source={{ uri: imageUri }}
                style={styles.previewFullscreenImage}
                resizeMode='contain'
              />
            ) : (
              <View style={styles.previewFallbackCard}>
                <Text style={styles.previewFallbackTitle}>
                  {isVideo ? 'Video' : 'File preview'}
                </Text>
                <Text style={styles.previewFallbackText}>
                  {isVideo
                    ? 'Video inline playback is not enabled yet in this modal.'
                    : 'No inline preview is available for this file type.'}
                </Text>
                <Text style={styles.previewFallbackText}>Swipe down or tap X to close.</Text>
              </View>
            )}
          </View>
        </Animated.View>
      </View>
    </Modal>
  )
}

async function loadPersistedMetadata(): Promise<PersistedMetadata | null> {
  try {
    const info = await FileSystem.getInfoAsync(METADATA_PATH)
    if (!info.exists) return null
    const raw = await FileSystem.readAsStringAsync(METADATA_PATH, {
      encoding: FileSystem.EncodingType.UTF8
    })
    const parsed = JSON.parse(String(raw || '{}'))
    return {
      files: Array.isArray(parsed.files) ? parsed.files : [],
      starredHosts: Array.isArray(parsed.starredHosts) ? parsed.starredHosts : [],
      hostHistory: Array.isArray(parsed.hostHistory) ? parsed.hostHistory : [],
      hostHistoryRemoved: Array.isArray(parsed.hostHistoryRemoved) ? parsed.hostHistoryRemoved : [],
      themeMode:
        parsed.themeMode === 'dark' || parsed.themeMode === 'light' || parsed.themeMode === 'system'
          ? parsed.themeMode
          : 'system',
      hostPackagingMode: parsed.hostPackagingMode === 'raw' ? 'raw' : 'zip',
      peerName: String(parsed.peerName || ''),
      onboardingDone: Boolean(parsed.onboardingDone)
    }
  } catch {
    return null
  }
}

function rememberHostHistory(existing: any[], transfer: any, fallback: any = {}) {
  const normalized = normalizeHostHistoryRecord(transfer || fallback, fallback)
  if (!normalized) return existing
  return mergeHostHistory([normalized], existing)
}

function mergeHostHistory(primary: any[], secondary: any[]) {
  const map = new Map<string, any>()
  const combined = [
    ...(Array.isArray(primary) ? primary : []),
    ...(Array.isArray(secondary) ? secondary : [])
  ]
  for (const entry of combined) {
    const normalized = normalizeHostHistoryRecord(entry)
    if (!normalized) continue
    const key =
      String(normalized.transferId || normalized.id || '') ||
      String(normalized.invite || '') ||
      `${String(normalized.sessionLabel || normalized.sessionName || 'upload')}:${Number(normalized.createdAt || 0)}`
    if (!key) continue
    const existing = map.get(key)
    if (!existing || Number(normalized.createdAt || 0) >= Number(existing.createdAt || 0)) {
      const next = { ...normalized }
      const existingSourceRefs = Array.isArray(existing?.sourceRefs) ? existing.sourceRefs : []
      const nextSourceRefs = Array.isArray(next.sourceRefs) ? next.sourceRefs : []
      if (!nextSourceRefs.length && existingSourceRefs.length) {
        next.sourceRefs = existingSourceRefs
      }
      map.set(key, next)
    }
  }
  return Array.from(map.values())
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, 300)
}

function normalizeHostHistoryRecord(entry: any, fallback: any = {}) {
  if (!entry || typeof entry !== 'object') return null
  const invite = String(entry.invite || fallback.invite || '')
  const transferId = String(entry.transferId || fallback.transferId || entry.id || '')
  const manifest = Array.isArray(entry.manifest)
    ? entry.manifest
    : Array.isArray(fallback.manifest)
      ? fallback.manifest
      : []
  const sourceRefs = Array.isArray(entry.sourceRefs)
    ? entry.sourceRefs
    : Array.isArray(fallback.sourceRefs)
      ? fallback.sourceRefs
      : []
  return {
    ...entry,
    type: 'upload',
    transferId: transferId || String(entry.id || ''),
    invite,
    sessionName: String(entry.sessionName || fallback.sessionName || 'Host Session'),
    sessionLabel: String(
      entry.sessionLabel || fallback.sessionLabel || entry.sessionName || fallback.sessionName || ''
    ),
    hostMode: (String(entry.hostMode || fallback.hostMode || '').toLowerCase() === 'zip'
      ? 'zip'
      : 'raw') as HostPackaging,
    createdAt: Number(entry.createdAt || fallback.createdAt || Date.now()),
    totalBytes: Number(entry.totalBytes || fallback.totalBytes || 0),
    fileCount: Number(entry.fileCount || fallback.fileCount || manifest.length || 0),
    manifest,
    sourceRefs
  }
}

function historyEntryKey(entry: any): string {
  if (!entry || typeof entry !== 'object') return ''
  return String(entry.transferId || entry.id || entry.invite || '').trim()
}

async function toUploadPayload(
  item: FileRecord,
  rpc: { request: (command: number, payload?: any) => Promise<any> },
  setFiles: (updater: (prev: FileRecord[]) => FileRecord[]) => void,
  options: { preferPath?: boolean } = {}
) {
  const mimeType = item.mimeType || guessMime(item.name)
  const preferPath = options.preferPath === true

  if (typeof item.dataBase64 === 'string') {
    return {
      name: item.name,
      mimeType,
      dataBase64: item.dataBase64
    }
  }

  const localPath = String(item.path || '').trim()
  const normalizedLocalPath = normalizeFileUri(localPath)
  if (localPath) {
    if (preferPath) {
      try {
        const info = await FileSystem.getInfoAsync(normalizedLocalPath || localPath)
        if (info?.exists) {
          const stagingPath = await materializeHostPathIfNeeded(
            normalizedLocalPath || localPath,
            item.name
          )
          return {
            name: item.name,
            mimeType,
            path: toHostReadablePath(stagingPath || normalizedLocalPath || localPath)
          }
        }
      } catch {}
      const fallbackPath = await resolveMediaAssetPath(item)
      if (fallbackPath) {
        const stagingPath = await materializeHostPathIfNeeded(fallbackPath, item.name)
        return {
          name: item.name,
          mimeType,
          path: toHostReadablePath(stagingPath || fallbackPath)
        }
      }
      return null
    }
    try {
      const dataBase64 = await FileSystem.readAsStringAsync(normalizedLocalPath || localPath, {
        encoding: FileSystem.EncodingType.Base64
      })
      if (dataBase64) {
        const coverArtDataUrl =
          String(item.coverArtDataUrl || '').trim() ||
          extractMp3CoverArtDataUrlFromBase64(dataBase64, item.name, mimeType)
        setFiles((prev) =>
          prev.map((entry) =>
            entry.id === item.id
              ? { ...entry, dataBase64, mimeType, path: localPath, coverArtDataUrl }
              : entry
          )
        )
        return {
          name: item.name,
          mimeType,
          dataBase64
        }
      }
    } catch {}
  }

  if (preferPath) {
    const fallbackPath = await resolveMediaAssetPath(item)
    if (fallbackPath) {
      const stagingPath = await materializeHostPathIfNeeded(fallbackPath, item.name)
      return {
        name: item.name,
        mimeType,
        path: toHostReadablePath(stagingPath || fallbackPath)
      }
    }
  }

  if (!item.invite) return null

  try {
    const manifest = await rpc.request(RpcCommand.GET_MANIFEST, { invite: item.invite })
    const files = Array.isArray(manifest?.files) ? manifest.files : []
    const match =
      files.find((entry: any) => String(entry.drivePath || '') === String(item.drivePath || '')) ||
      files.find((entry: any) => String(entry.name || '') === String(item.name || '')) ||
      files[0]
    if (!match?.drivePath) return null

    const read = await rpc.request(RpcCommand.READ_ENTRY, {
      invite: item.invite,
      drivePath: match.drivePath
    })
    const dataBase64 = String(read?.dataBase64 || '')
    if (!dataBase64) return null
    const resolvedMime = item.mimeType || match.mimeType || guessMime(item.name)

    setFiles((prev) =>
      prev.map((entry) =>
        entry.id === item.id
          ? { ...entry, dataBase64, drivePath: match.drivePath, mimeType: resolvedMime }
          : entry
      )
    )
    return {
      name: item.name,
      mimeType: resolvedMime,
      dataBase64
    }
  } catch {
    return null
  }
}

function buildZipPayload(
  items: Array<{ name: string; mimeType?: string; dataBase64: string }>,
  sessionName: string
) {
  const files: Record<string, Uint8Array> = {}
  const usedNames = new Set<string>()

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const safe = sanitizeFileName(String(item?.name || `file-${i + 1}`))
    const { namePart, extPart } = splitFileNameExt(safe)
    const base = namePart || `file-${i + 1}`
    const ext = extPart ? `.${extPart}` : ''
    let candidate = `${base}${ext}`
    let suffix = 2
    while (usedNames.has(candidate)) {
      candidate = `${base}-${suffix}${ext}`
      suffix += 1
    }
    usedNames.add(candidate)
    files[candidate] = b4a.from(String(item?.dataBase64 || ''), 'base64')
  }

  // iOS JS thread can appear frozen during heavy compression.
  // Use store mode (level 0) for fast, reliable archive creation.
  const zipBytes = zipSync(files, { level: 0 })
  const zipBase64 = b4a.toString(b4a.from(zipBytes), 'base64')
  const zipNameBase = sanitizeFileName(String(sessionName || 'Host Session')).replaceAll(
    /\.[^.]+$/g,
    ''
  )
  const zipName = `${zipNameBase || 'Host-Session'}-${Date.now()}.zip`

  return {
    name: zipName,
    mimeType: 'application/zip',
    dataBase64: zipBase64,
    byteLength: zipBytes.byteLength
  }
}

async function savePersistedMetadata(payload: PersistedMetadata): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(METADATA_PATH, JSON.stringify(payload), {
      encoding: FileSystem.EncodingType.UTF8
    })
  } catch {
    // Ignore write failures for now; worker transfer state remains intact.
  }
}

function promptIosDownloadDestination(includePhotos: boolean): Promise<'files' | 'photos' | null> {
  return new Promise((resolve) => {
    const buttons: Array<{
      text: string
      style?: 'cancel'
      onPress?: () => void
    }> = [
      {
        text: 'Save to Files app',
        onPress: () => resolve('files')
      }
    ]
    if (includePhotos) {
      buttons.push({
        text: 'Save to Photos app',
        onPress: () => resolve('photos')
      })
    }
    buttons.push({
      text: 'Cancel',
      style: 'cancel',
      onPress: () => resolve(null)
    })
    Alert.alert('Save download to…', 'Choose where downloaded files should go.', buttons, {
      cancelable: true,
      onDismiss: () => resolve(null)
    })
  })
}

function isIosPhotosCompatibleMedia(mimeType: string, name = ''): boolean {
  const value = String(mimeType || '').toLowerCase()
  const ext = fileExt(String(name || '')).toLowerCase()
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp'].includes(ext)) return true
  if (['mp4', 'mov', 'm4v'].includes(ext)) return true
  if (value.startsWith('image/')) {
    if (value.includes('svg') || value.includes('tiff')) return false
    return (
      value.includes('jpeg') ||
      value.includes('png') ||
      value.includes('heic') ||
      value.includes('heif') ||
      value.includes('gif') ||
      value.includes('webp')
    )
  }
  if (value.startsWith('video/')) {
    return value.includes('mp4') || value.includes('quicktime')
  }
  return false
}

async function saveArtifactsToIosPhotos(
  artifacts: Array<{ path: string; mimeType: string }>
): Promise<number> {
  if (!artifacts.length) return 0
  const media = artifacts.filter((item) =>
    isIosPhotosCompatibleMedia(item.mimeType, String(item.path || ''))
  )
  if (!media.length) return 0
  const permission = await MediaLibrary.requestPermissionsAsync()
  if (!permission.granted) {
    throw new Error('Photos permission was not granted.')
  }
  let saved = 0
  for (const item of media) {
    // Keep save order deterministic for user confirmation.
    // eslint-disable-next-line no-await-in-loop
    await MediaLibrary.saveToLibraryAsync(item.path)
    saved += 1
  }
  return saved
}

async function shareArtifactsToIosFiles(
  artifacts: Array<{ path: string; name: string; byteLength?: number }>,
  onProgress?: (done: number, total: number, subtitle: string) => void
): Promise<void> {
  if (!artifacts.length) return
  if (artifacts.length === 1) {
    onProgress?.(1, 1, 'Opening Files share sheet...')
    await Share.share({
      url: artifacts[0].path,
      title: artifacts[0].name
    })
    return
  }
  const files: Record<string, Uint8Array> = {}
  const totalSteps = artifacts.length + 3
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i]
    const safeName = sanitizeFileName(artifact.name || `file-${i + 1}`)
    onProgress?.(i, totalSteps, `Reading ${safeName}...`)
    const readingStartedAt = Date.now()
    const pulseTimer = setInterval(() => {
      const seconds = Math.max(1, Math.floor((Date.now() - readingStartedAt) / 1000))
      onProgress?.(i, totalSteps, `Reading ${safeName}... ${seconds}s`)
    }, 700)
    const dataBase64 = await FileSystem.readAsStringAsync(artifact.path, {
      encoding: FileSystem.EncodingType.Base64
    }).finally(() => {
      clearInterval(pulseTimer)
    })
    files[safeName] = b4a.from(dataBase64, 'base64')
    onProgress?.(i + 1, totalSteps, `Added ${safeName}`)
  }
  const compressBase = artifacts.length
  const compressTop = Math.max(compressBase + 1, totalSteps - 1)
  onProgress?.(compressBase, totalSteps, 'Compressing zip...')
  // Use store mode to avoid long JS-thread compression stalls on RN.
  const zipBytes = zipSync(files, { level: 0 })
  const zipPath = `${FileSystem.cacheDirectory || FileSystem.documentDirectory || ''}PearDrop-${Date.now()}.zip`
  onProgress?.(compressTop, totalSteps, 'Writing zip...')
  await FileSystem.writeAsStringAsync(zipPath, b4a.toString(b4a.from(zipBytes), 'base64'), {
    encoding: FileSystem.EncodingType.Base64
  })
  onProgress?.(totalSteps, totalSteps, 'Opening Files share sheet...')
  await Share.share({
    url: zipPath,
    title: 'PearDrop download zip'
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function requestInit(rpc: { request: (command: number, payload?: any) => Promise<any> }) {
  return withTimeout(
    rpc.request(RpcCommand.INIT),
    MOBILE_WORKER_INIT_TIMEOUT_MS,
    `Worker init RPC timed out after ${MOBILE_WORKER_INIT_TIMEOUT_MS}ms`
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveMediaAssetPath(item: FileRecord): Promise<string> {
  const assetId = String(item?.sourceAssetId || '').trim()
  if (!assetId) return ''
  try {
    const info = await MediaLibrary.getAssetInfoAsync(assetId, {
      shouldDownloadFromNetwork: true
    })
    const localUri = String(info?.localUri || info?.uri || '').trim()
    if (!localUri) return ''
    if (!localUri.startsWith('file://')) return ''
    const fileInfo = await FileSystem.getInfoAsync(localUri)
    if (!fileInfo?.exists) return ''
    return localUri
  } catch {
    return ''
  }
}

function normalizeFileUri(value: string): string {
  const source = String(value || '').trim()
  if (!source) return ''
  if (source.startsWith('file://')) return source
  if (source.startsWith('/')) return `file://${source}`
  return source
}

function toHostReadablePath(value: string): string {
  const normalized = normalizeFileUri(value)
  if (normalized.startsWith('file://')) {
    return decodeURIComponent(normalized.slice('file://'.length))
  }
  return String(value || '').trim()
}

async function materializeHostPathIfNeeded(localPath: string, fileName = ''): Promise<string> {
  const source = normalizeFileUri(localPath)
  if (!source) return ''
  if (Platform.OS !== 'ios') return ''
  if (!source.startsWith('file://')) return ''
  if (!source.includes('/Library/Caches/ImagePicker/')) return ''
  try {
    await FileSystem.makeDirectoryAsync(IOS_HOST_STAGING_DIR, { intermediates: true }).catch(
      () => {}
    )
    const safe = sanitizeFileName(String(fileName || source.split('/').pop() || 'media'))
    const ext = fileExt(safe).toLowerCase()
    const stem = ext ? safe.slice(0, -(ext.length + 1)) : safe
    const out = `${IOS_HOST_STAGING_DIR}/${stem || 'media'}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext ? `.${ext}` : ''}`
    await FileSystem.copyAsync({ from: source, to: out })
    return out
  } catch {
    return ''
  }
}

function redactInviteText(value: string): string {
  const text = String(value || '')
  return text
    .replace(/peardrops:\/\/invite[^\s)]+/gi, '[invite hidden]')
    .replace(/peardrops-web:\/\/join[^\s)]+/gi, '[invite hidden]')
    .replace(/([?&]invite=)[^&\s)]+/gi, '$1[invite hidden]')
}

async function resolveAndroidDownloadsDirUri(): Promise<string> {
  if (Platform.OS !== 'android') return ''
  if (androidDownloadsDirUriCache) return androidDownloadsDirUriCache
  const rootUri = FileSystem.StorageAccessFramework.getUriForDirectoryInRoot('Download')
  let permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(rootUri)
  if (!permission.granted) {
    permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync()
  }
  if (!permission.granted || !permission.directoryUri) return ''
  androidDownloadsDirUriCache = String(permission.directoryUri)
  return androidDownloadsDirUriCache
}

async function canWriteAndroidPublicDownloads(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  const probePath = `${ANDROID_DOWNLOADS_FILE_URI}/.peardrops-write-probe-${Date.now()}.tmp`
  try {
    await FileSystem.writeAsStringAsync(probePath, 'ok', {
      encoding: FileSystem.EncodingType.UTF8
    })
    await FileSystem.deleteAsync(probePath, { idempotent: true }).catch(() => {})
    return true
  } catch {
    return false
  }
}

async function createAndroidDownloadFileUri(
  directoryUri: string,
  fileName: string,
  mimeType: string
): Promise<string> {
  const safe = sanitizeFileName(fileName)
  const { namePart, extPart } = splitFileNameExt(safe)
  const baseName = String(namePart || 'download').trim() || 'download'
  const ext = String(extPart || '').trim()
  const fullName = ext ? `${baseName}.${ext}` : baseName
  const mime = String(mimeType || guessMime(fullName) || 'application/octet-stream')

  let attempt = 0
  while (attempt < 100) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    try {
      return await FileSystem.StorageAccessFramework.createFileAsync(
        directoryUri,
        `${baseName}${suffix}`,
        mime
      )
    } catch (error: any) {
      const message = String(error?.message || '')
      if (!message.toLowerCase().includes('already exists')) throw error
      attempt += 1
    }
  }

  throw new Error('Could not allocate a file in Downloads folder')
}

function splitFileNameExt(name: string): { namePart: string; extPart: string } {
  const safe = String(name || '').trim()
  const idx = safe.lastIndexOf('.')
  if (idx <= 0 || idx === safe.length - 1) return { namePart: safe, extPart: '' }
  return {
    namePart: safe.slice(0, idx),
    extPart: safe.slice(idx + 1)
  }
}

function sanitizeFileName(name: string): string {
  const fallback = String(name || 'download').trim() || 'download'
  return fallback.replaceAll(/[\\/:*?"<>|]+/g, '_')
}

function formatDate(value: number) {
  return new Date(value || Date.now()).toLocaleDateString()
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatEta(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s`
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return `${hours}h ${remMinutes}m`
}

function fileExt(name: string) {
  const raw = String(name || '')
    .trim()
    .split('?')[0]
    .split('#')[0]
  const idx = raw.lastIndexOf('.')
  if (idx < 0) return ''
  return raw.slice(idx + 1).trim()
}

function guessMime(name: string) {
  const ext = fileExt(name).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'heic' || ext === 'heif') return 'image/heic'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  return 'application/octet-stream'
}

function parseHostSessionLabel(label: string) {
  const value = String(label || '').trim()
  if (!value) return { title: 'Host Session', embeddedDateTime: '', hash: '' }

  const parts = value.split(/\s+/).filter(Boolean)
  if (!parts.length) return { title: 'Host Session', embeddedDateTime: '', hash: '' }

  let hash = ''
  if (/^[a-f0-9]{3,8}$/i.test(parts[parts.length - 1])) {
    hash = parts.pop() || ''
  }

  let embeddedDateTime = ''
  const isDate = (part: string) => /^\d{4}-\d{2}-\d{2}$/.test(part)
  const isTime = (part: string) => /^\d{2}:\d{2}(:\d{2})?$/.test(part)
  if (parts.length >= 2 && isDate(parts[parts.length - 2]) && isTime(parts[parts.length - 1])) {
    embeddedDateTime = `${parts[parts.length - 2]} ${parts[parts.length - 1]}`
    parts.splice(parts.length - 2, 2)
  } else if (parts.length >= 1 && isDate(parts[parts.length - 1])) {
    embeddedDateTime = parts[parts.length - 1]
    parts.splice(parts.length - 1, 1)
  }

  return {
    title: parts.join(' ').trim() || 'Host Session',
    embeddedDateTime,
    hash
  }
}

function formatHostSessionDateLine(createdAt: number | undefined, fallbackDateTime = '') {
  const ts = Number(createdAt || 0)
  if (Number.isFinite(ts) && ts > 0) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {}
  }
  return String(fallbackDateTime || '').trim()
}

function isMp3File(name = '', mimeType = '') {
  const lowerName = String(name || '').toLowerCase()
  const lowerMime = String(mimeType || '').toLowerCase()
  return lowerName.endsWith('.mp3') || lowerMime === 'audio/mpeg' || lowerMime === 'audio/mp3'
}

async function readMp3CoverArtFromUri(uri = '', name = '', mimeType = '', byteLength = 0) {
  if (!isMp3File(name, mimeType)) return ''
  if (!uri) return ''
  if (byteLength > 30 * 1024 * 1024) return ''
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64
    })
    if (!base64) return ''
    return extractMp3CoverArtDataUrlFromBase64(base64, name, mimeType)
  } catch {
    return ''
  }
}

function extractMp3CoverArtDataUrlFromBase64(base64 = '', name = '', mimeType = '') {
  if (!isMp3File(name, mimeType)) return ''
  if (!base64) return ''
  try {
    const bytes = b4a.from(base64, 'base64')
    return extractMp3CoverArtFromBytes(bytes)
  } catch {
    return ''
  }
}

function extractMp3CoverArtFromBytes(bytes: Uint8Array) {
  if (!bytes || bytes.length < 10) return ''
  if (readLatin1(bytes, 0, 3) !== 'ID3') return ''
  const version = bytes[3]
  if (version !== 3 && version !== 4) return ''
  const tagSize = readSynchsafeInt(bytes, 6)
  const tagEnd = Math.min(bytes.length, 10 + tagSize)
  let cursor = 10

  while (cursor + 10 <= tagEnd) {
    const frameId = readLatin1(bytes, cursor, cursor + 4)
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break
    const frameSize =
      version === 4 ? readSynchsafeInt(bytes, cursor + 4) : readUInt32BE(bytes, cursor + 4)
    if (!Number.isFinite(frameSize) || frameSize <= 0) break
    const payloadStart = cursor + 10
    const payloadEnd = payloadStart + frameSize
    if (payloadEnd > tagEnd) break

    if (frameId === 'APIC') {
      const payload = bytes.subarray(payloadStart, payloadEnd)
      const cover = parseApicPayload(payload)
      if (cover) return cover
    }

    cursor = payloadEnd
  }

  return ''
}

function parseApicPayload(payload: Uint8Array) {
  if (!payload || payload.length < 4) return ''
  const encoding = payload[0]
  let cursor = 1
  const mimeEnd = indexOfByte(payload, 0x00, cursor)
  if (mimeEnd < 0) return ''
  const mimeType = readLatin1(payload, cursor, mimeEnd).trim() || 'image/jpeg'
  cursor = mimeEnd + 1
  if (cursor >= payload.length) return ''
  cursor += 1
  if (cursor >= payload.length) return ''

  if (encoding === 0x01 || encoding === 0x02) {
    while (cursor + 1 < payload.length) {
      if (payload[cursor] === 0x00 && payload[cursor + 1] === 0x00) {
        cursor += 2
        break
      }
      cursor += 2
    }
  } else {
    const descEnd = indexOfByte(payload, 0x00, cursor)
    if (descEnd >= 0) cursor = descEnd + 1
  }

  if (cursor >= payload.length) return ''
  const imageBytes = payload.subarray(cursor)
  if (!imageBytes.length) return ''
  return `data:${mimeType};base64,${b4a.toString(imageBytes, 'base64')}`
}

function readLatin1(bytes: Uint8Array, start: number, end: number) {
  let out = ''
  for (let i = start; i < Math.min(end, bytes.length); i++) out += String.fromCharCode(bytes[i])
  return out
}

function indexOfByte(bytes: Uint8Array, value: number, start: number) {
  for (let i = Math.max(0, start); i < bytes.length; i++) {
    if (bytes[i] === value) return i
  }
  return -1
}

function readSynchsafeInt(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  )
}

function readUInt32BE(bytes: Uint8Array, offset: number) {
  return (
    (((bytes[offset] & 0xff) << 24) |
      ((bytes[offset + 1] & 0xff) << 16) |
      ((bytes[offset + 2] & 0xff) << 8) |
      (bytes[offset + 3] & 0xff)) >>>
    0
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5'
  },
  topHeader: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end'
  },
  settingsBtn: {
    minWidth: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0
  },
  settingsBtnText: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 20
  },
  optionItemTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f1f1f'
  },
  optionThemeRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8
  },
  optionThemeBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d8dce3',
    alignItems: 'center',
    justifyContent: 'center'
  },
  optionThemeBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#607086'
  },
  searchInput: {
    marginHorizontal: 16,
    backgroundColor: '#ececec',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d8dce3',
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: '#333'
  },
  mainTabsRow: {
    marginTop: 8,
    marginHorizontal: 16,
    flexDirection: 'row',
    gap: 8
  },
  mainTabBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#d8dce3',
    alignItems: 'center',
    justifyContent: 'center'
  },
  mainTabBtnActive: {
    borderColor: '#7dc994'
  },
  mainTabBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#d8dce3'
  },
  mainTabBtnTextActive: {
    color: '#fff'
  },
  themeLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  themeIconBadge: {
    width: 20,
    height: 20,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  themeGlyph: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2
  },
  themeDropdownCard: {
    width: '78%',
    maxWidth: 340,
    borderWidth: 1,
    borderColor: '#d8dce3',
    borderRadius: 14,
    padding: 8,
    gap: 8
  },
  themeDropdownOption: {
    borderWidth: 1,
    borderColor: '#d8dce3',
    borderRadius: 11,
    paddingVertical: 10,
    paddingHorizontal: 12
  },
  themeDropdownOptionActive: {
    borderColor: '#71b887'
  },
  themeOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  themeOptionCheck: {
    fontSize: 13,
    fontWeight: '700',
    opacity: 0.9
  },
  themeDropdownOptionText: {
    fontSize: 14,
    fontWeight: '600'
  },
  scrollContent: {
    paddingTop: 8,
    paddingBottom: 120,
    gap: 10
  },
  filesTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 2
  },
  inlineActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10
  },
  inviteInputRow: {
    marginHorizontal: 16,
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  inviteInputRowField: {
    flex: 1,
    marginTop: 0,
    marginHorizontal: 0
  },
  hostNewActionBtn: {
    width: 42,
    minHeight: 42,
    height: 42,
    borderRadius: 10,
    paddingHorizontal: 0,
    paddingVertical: 0
  },
  inviteRow: {
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#d9d9d9',
    borderRadius: 14,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  inviteRowText: {
    flex: 1,
    color: '#4b4b4b',
    fontSize: 12
  },
  bulkBar: {
    marginHorizontal: 16,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#d9d9d9',
    borderRadius: 14,
    backgroundColor: '#4b4b4b',
    padding: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8
  },
  bulkText: {
    color: '#636363',
    marginRight: 8
  },
  primaryBtn: {
    backgroundColor: '#7dc994',
    borderRadius: 12,
    minHeight: 42,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center'
  },
  primaryBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14
  },
  loadingInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#3a4554',
    borderRadius: 12,
    minHeight: 42,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center'
  },
  secondaryBtnText: {
    color: '#7dc994',
    fontWeight: '700',
    fontSize: 14
  },
  chipRow: {
    marginTop: 8,
    marginHorizontal: 16
  },
  chip: {
    backgroundColor: '#e9e9e9',
    borderRadius: 10,
    minHeight: 36,
    paddingVertical: 7,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8
  },
  chipActive: {
    backgroundColor: '#7dc994'
  },
  chipText: {
    color: '#5e5e5e',
    fontWeight: '600',
    fontSize: 13
  },
  chipTextActive: {
    color: '#fff'
  },
  filesList: {
    marginTop: 10,
    marginHorizontal: 16,
    gap: 10
  },
  emptyFileDropzone: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d8dce3',
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 26,
    gap: 10
  },
  emptyFileIconWrap: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#d8dce3'
  },
  emptyFileDropzoneTitle: {
    fontSize: 18,
    fontWeight: '700'
  },
  emptyFileDropzoneSub: {
    fontSize: 13,
    textAlign: 'center'
  },
  inviteLoaderCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d8dce3',
    paddingVertical: 18,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  hostRecentSeparator: {
    marginTop: 6,
    marginBottom: 2
  },
  hostRecentSeparatorText: {
    color: '#666',
    fontWeight: '700'
  },
  hostSection: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingTop: 2,
    gap: 12
  },
  sectionBar: {
    width: '100%',
    minHeight: 38,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d8dce3',
    paddingHorizontal: 14,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10
  },
  sectionBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  sectionBarCount: {
    fontSize: 13,
    fontWeight: '700'
  },
  peerCard: {
    gap: 0
  },
  hostSectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  hostCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d8dce3',
    padding: 12,
    gap: 6
  },
  hostCardGlow: {
    borderColor: '#1ba344',
    shadowColor: '#1ba344',
    shadowOpacity: 0.32,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6
  },
  hostCardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8
  },
  hostCardTitleWrap: {
    flex: 1
  },
  hostCardTitle: {
    fontWeight: '700',
    color: '#1f1f1f'
  },
  hostHashInline: {
    fontSize: 12,
    fontWeight: '600',
    color: '#7a8795'
  },
  hostMetaDate: {
    fontSize: 12,
    color: '#798796',
    marginTop: 2
  },
  hostMetaSize: {
    fontSize: 11,
    color: '#91a0ae',
    marginTop: 1
  },
  hostCardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4
  },
  hostDetailHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  hostDetailTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f1f1f',
    flex: 1
  },
  hostFileRow: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d8dce3',
    padding: 10,
    gap: 4
  },
  hostRefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#d8dce3',
    borderRadius: 10
  },
  hostRefMeta: {
    flex: 1,
    gap: 2
  },
  hostRefMetaTouch: {
    flex: 1,
    gap: 2
  },
  hostRefTitle: {
    fontWeight: '600',
    color: '#1f1f1f'
  },
  hostRefPath: {
    fontSize: 12,
    color: '#8b9aa8'
  },
  folderActionRow: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d8dce3',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  folderActionText: {
    color: '#5e5e5e',
    fontWeight: '600'
  },
  fileRow: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d8dce3',
    padding: 11,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    minHeight: 84
  },
  fileMeta: {
    flex: 1,
    gap: 4
  },
  fileMetaTouch: {
    flex: 1,
    gap: 4
  },
  checkBtn: {
    marginRight: 2
  },
  checkText: {
    fontSize: 17,
    color: '#454545'
  },
  previewBox: {
    width: 54,
    height: 54,
    borderRadius: 12,
    backgroundColor: '#eef0f3',
    borderWidth: 1,
    borderColor: '#dce2ea',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  previewImage: {
    width: '100%',
    height: '100%'
  },
  invitePreviewSkeleton: {
    width: '100%',
    height: '100%',
    marginTop: 0
  },
  previewText: {
    color: '#73767f',
    fontSize: 12,
    fontWeight: '600'
  },
  fileName: {
    fontWeight: '700',
    fontSize: 15,
    color: '#1f1f1f'
  },
  fileSub: {
    color: '#717171',
    fontSize: 13
  },
  fileActions: {
    flexDirection: 'row',
    gap: 8
  },
  inviteLoadMoreWrap: {
    marginTop: 8,
    alignItems: 'flex-start'
  },
  rowBtn: {
    backgroundColor: '#efefef',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d5dbe3',
    minWidth: 34,
    minHeight: 34,
    paddingVertical: 6,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center'
  },
  rowBtnText: {
    color: '#444',
    fontSize: 13,
    fontWeight: '600'
  },
  rowDeleteText: {
    color: '#c44949'
  },
  rowDeleteTone: {
    backgroundColor: '#c44949'
  },
  rowDeleteToneBorder: {
    borderColor: '#c44949'
  },
  miniTrash: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'flex-start'
  },
  miniTrashLid: {
    width: 10,
    height: 2,
    borderRadius: 1,
    marginBottom: 1
  },
  miniTrashBody: {
    width: 9,
    height: 9,
    borderWidth: 1.5,
    borderRadius: 1.5,
    flexDirection: 'row',
    justifyContent: 'center',
    columnGap: 1
  },
  miniTrashLine: {
    width: 1.2,
    height: 5.2,
    marginTop: 1
  },
  rowBtnDisabled: {
    opacity: 0.5
  },
  backArrowBtn: {
    paddingVertical: 4,
    paddingHorizontal: 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  backArrowText: {
    fontSize: 22,
    fontWeight: '600'
  },
  pressFeedback: {
    opacity: 0.78
  },
  placeholderCard: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    gap: 8
  },
  placeholderTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#222'
  },
  muted: {
    color: '#777'
  },
  codeText: {
    color: '#4a4a4a',
    fontSize: 12
  },
  viewTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1f1f1f',
    flex: 1
  },
  workerBootSkeletonWrap: {
    marginTop: 6,
    gap: 6
  },
  skeletonBlock: {
    flex: 1
  },
  skeletonShimmerOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 170,
    backgroundColor: 'rgba(255,255,255,0.45)'
  },
  workerBootSkeletonLineLg: {
    height: 10,
    width: '92%',
    borderRadius: 999
  },
  workerBootSkeletonLineMd: {
    height: 10,
    width: '76%',
    borderRadius: 999
  },
  workerBootSkeletonLineSm: {
    height: 10,
    width: '58%',
    borderRadius: 999
  },
  skeletonListWrap: {
    gap: 10
  },
  skeletonContainerCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d7dfea',
    overflow: 'hidden'
  },
  skeletonUploadContainer: {
    minHeight: 270
  },
  skeletonDownloadContainer: {
    minHeight: 250
  },
  skeletonThumb: {
    width: 46,
    height: 46,
    borderRadius: 10
  },
  skeletonTextWrap: {
    flex: 1,
    gap: 7
  },
  skeletonLineLg: {
    height: 10,
    width: '86%',
    borderRadius: 999
  },
  skeletonLineSm: {
    height: 10,
    width: '58%',
    borderRadius: 999
  },
  skeletonActionDot: {
    width: 22,
    height: 22,
    borderRadius: 999
  },
  fab: {
    position: 'absolute',
    right: 18,
    bottom: 84,
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: '#7dc994',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4
  },
  fabText: {
    color: '#fff',
    fontSize: 30,
    marginTop: -2
  },
  fabMenu: {
    position: 'absolute',
    right: 18,
    bottom: 146,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e3e3e3',
    padding: 8,
    gap: 6
  },
  fabItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#f4f4f4'
  },
  fabItemText: {
    color: '#222',
    fontWeight: '600'
  },
  folderModalRoot: {
    flex: 1,
    justifyContent: 'center',
    padding: 20
  },
  themeModalRoot: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 118
  },
  folderModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)'
  },
  folderModalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    gap: 10,
    maxHeight: '80%'
  },
  folderModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e1e1e'
  },
  folderOptionsScroll: {
    maxHeight: 220
  },
  folderOptionBtn: {
    backgroundColor: '#f0f0f0',
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 10,
    marginBottom: 6
  },
  folderOptionText: {
    color: '#242424',
    fontWeight: '600'
  },
  folderInput: {
    borderWidth: 1,
    borderColor: '#d8d8d8',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#fff'
  },
  folderModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8
  },
  previewModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end'
  },
  previewBackdrop: {
    ...StyleSheet.absoluteFillObject
  },
  previewSheet: {
    height: '88%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: '#111'
  },
  previewSheetHead: {
    height: 52,
    borderBottomWidth: 1,
    borderBottomColor: '#2f2f2f',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14
  },
  previewSheetTitle: {
    color: '#f1f3f4',
    fontWeight: '700',
    flex: 1
  },
  previewCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4f4f4f',
    alignItems: 'center',
    justifyContent: 'center'
  },
  previewCloseText: {
    color: '#f1f3f4',
    fontSize: 14,
    fontWeight: '700'
  },
  previewSheetBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14
  },
  previewFullscreenImage: {
    width: '100%',
    height: '100%'
  },
  previewFallbackCard: {
    borderWidth: 2,
    borderColor: '#5a5a5a',
    borderRadius: 14,
    backgroundColor: '#1a1a1a',
    padding: 20,
    maxWidth: '94%'
  },
  previewFallbackTitle: {
    color: '#e8eaf0',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8
  },
  previewFallbackText: {
    color: '#b7bdc9',
    lineHeight: 20
  },
  panelTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 10
  },
  joiningPeersPanel: {
    marginBottom: 8
  },
  peerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 6
  },
  peerRowMain: {
    flex: 1,
    minWidth: 0
  },
  progressTrack: {
    marginTop: 6,
    height: 7,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#dcdfe4'
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#7dc994'
  },
  onboardingShell: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 16
  },
  onboardingCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16
  },
  onboardingTitle: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 6
  },
  onboardingCopy: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12
  },
  onboardingThemeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12
  },
  onboardingThemeBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d8d8d8',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center'
  },
  onboardingInput: {
    borderWidth: 1,
    borderColor: '#d8d8d8',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  onboardingContinueBtn: {
    marginTop: 14
  },
  onboardingSpinnerRow: {
    marginTop: 8
  }
})
