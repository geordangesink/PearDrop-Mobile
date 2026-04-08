/* global __DEV__ */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Alert,
  Modal,
  PanResponder,
  Image,
  Linking,
  Pressable,
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
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import RPC from 'bare-rpc'
import b4a from 'b4a'
import { Worklet } from 'react-native-bare-kit'
import bundle from './worker.bundle.js'
// @ts-ignore
import { extractInviteUrl } from './lib/invite'

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
  READ_ENTRY_CHUNK: 10
} as const

type FilesFilter = 'all' | 'starred' | 'host'
type ThemeMode = 'system' | 'dark' | 'light'
type MainTab = 'upload' | 'download'

type FileRecord = {
  id: string
  name: string
  byteLength: number
  updatedAt: number
  source: 'upload' | 'download' | 'local'
  invite: string
  path?: string
  drivePath?: string
  mimeType?: string
  dataBase64?: string
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
  sessionName?: string
  sessionLabel?: string
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
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const METADATA_PATH = `${FileSystem.documentDirectory || ''}peardrops-mobile-metadata.json`
const DEFAULT_DEV_RELAY = 'ws://localhost:49443'
const DEFAULT_PROD_RELAY = 'wss://pear-drops.up.railway.app'
const PUBLIC_SITE_ORIGIN = 'https://pear-drops.vercel.app'
const ANDROID_DOWNLOADS_FILE_URI = 'file:///storage/emulated/0/Download'
let androidDownloadsDirUriCache = ''

type PersistedMetadata = {
  files: FileRecord[]
  starred: string[]
  starredHosts?: string[]
  hostHistory?: any[]
  hostHistoryRemoved?: string[]
  themeMode?: ThemeMode
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
      background: '#0b0f14',
      panel: '#111821',
      panelSoft: '#161f2b',
      border: '#243142',
      text: '#eaf0f7',
      muted: '#92a1b6',
      accent: '#2793ff',
      danger: '#ff7b7b',
      inputPlaceholder: '#6f8098'
    }
  }
  return {
    background: '#f1f4f8',
    panel: '#ffffff',
    panelSoft: '#f5f8fc',
    border: '#d7dfea',
    text: '#111827',
    muted: '#64748b',
    accent: '#1f7ae0',
    danger: '#c44949',
    inputPlaceholder: '#7b8799'
  }
}

export default function App() {
  const systemScheme = useColorScheme()
  const [status, setStatus] = useState('Starting worker...')
  const [workerLog, setWorkerLog] = useState('Worker logs: waiting for events.')
  const [filesFilter, setFilesFilter] = useState<FilesFilter>('all')
  const [localSearch, setLocalSearch] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [mainTab, setMainTab] = useState<MainTab>('upload')
  const [latestInvite, setLatestInvite] = useState('')
  const [history, setHistory] = useState<any[]>([])
  const [hostHistory, setHostHistory] = useState<any[]>([])
  const [hostHistoryRemoved, setHostHistoryRemoved] = useState<Set<string>>(new Set())
  const [selectedHostHistory, setSelectedHostHistory] = useState<Set<string>>(new Set())
  const [activeHosts, setActiveHosts] = useState<ActiveHost[]>([])
  const [hostDetailInvite, setHostDetailInvite] = useState('')
  const [files, setFiles] = useState<FileRecord[]>([])
  const [starred, setStarred] = useState<Set<string>>(new Set())
  const [starredHosts, setStarredHosts] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null)
  const [metadataLoaded, setMetadataLoaded] = useState(false)
  const [hostNameModalVisible, setHostNameModalVisible] = useState(false)
  const [hostNameDraft, setHostNameDraft] = useState('Host Session')
  const [pendingHostMode, setPendingHostMode] = useState<'selected' | ''>('')
  const [inviteMode, setInviteMode] = useState(false)
  const [inviteSource, setInviteSource] = useState('')
  const [inviteEntries, setInviteEntries] = useState<InviteEntry[]>([])
  const [inviteSelected, setInviteSelected] = useState<Set<string>>(new Set())
  const previewTranslateY = useRef(new Animated.Value(0)).current
  const [hostingBusy, setHostingBusy] = useState(false)
  const [workerActivityBars, setWorkerActivityBars] = useState<WorkerActivityBar[]>([])
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const [themeDropdownOpen, setThemeDropdownOpen] = useState(false)
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

  const setWorkerLogMessage = (message: string) => {
    const text = redactInviteText(String(message || '').trim())
    setWorkerLog(`Worker log: ${text || 'waiting for events.'}`)
  }

  const upsertWorkerActivityBar = (
    id: string,
    label: string,
    done: number,
    total: number,
    options: { subtitle?: string; displayMode?: 'count' | 'bytes' } = {}
  ) => {
    const key = String(id || '').trim()
    if (!key) return
    const safeTotal = Math.max(1, Number(total || 0))
    const safeDone = Math.max(0, Math.min(safeTotal, Number(done || 0)))
    setWorkerActivityBars((prev) => {
      const next = prev.filter((item) => item.id !== key)
      next.push({
        id: key,
        label: String(label || 'Working...'),
        done: safeDone,
        total: safeTotal,
        subtitle: String(options.subtitle || ''),
        displayMode: options.displayMode || 'count'
      })
      return next
    })
  }

  const clearWorkerActivityBar = (id: string) => {
    const key = String(id || '').trim()
    if (!key) return
    setWorkerActivityBars((prev) => prev.filter((item) => item.id !== key))
  }

  const rpc = useMemo(() => {
    const worklet = new Worklet()
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
        worklet.terminate()
      }
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const initial = await requestInitWithRetry(rpc, 4)
        setHistory(initial.transfers || [])
        setHostHistory((prev) => mergeHostHistory(prev, initial.transfers || []))
        try {
          const hosts = await rpc.request(RpcCommand.LIST_ACTIVE_HOSTS)
          setActiveHosts(hosts.hosts || [])
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
      }
    })()

    return () => rpc.destroy()
  }, [rpc])

  useEffect(() => {
    void (async () => {
      const stored = await loadPersistedMetadata()
      if (!stored) {
        setMetadataLoaded(true)
        return
      }
      setFiles(stored.files || [])
      setStarred(new Set(stored.starred || []))
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
      setMetadataLoaded(true)
    })()
  }, [])

  useEffect(() => {
    if (!metadataLoaded) return
    const payload: PersistedMetadata = {
      files: files.slice(-600),
      starred: Array.from(starred),
      starredHosts: Array.from(starredHosts).slice(0, 300),
      hostHistory: hostHistory.slice(0, 300),
      hostHistoryRemoved: Array.from(hostHistoryRemoved).slice(0, 600),
      themeMode
    }
    void savePersistedMetadata(payload)
  }, [files, starred, starredHosts, hostHistory, hostHistoryRemoved, themeMode, metadataLoaded])

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
    if (filesFilter !== 'host') return
    void refreshHosts()
  }, [filesFilter])

  const visibleFiles = useMemo(() => {
    const q = localSearch.trim().toLowerCase()

    const filtered = files.filter((item) => {
      if (filesFilter === 'starred') return starred.has(item.id)
      if (filesFilter === 'host') return item.source === 'upload' || Boolean(item.invite)
      return true
    })

    const sorted = filtered
      .slice()
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 200)

    if (!q) return sorted
    return sorted.filter((item) => item.name.toLowerCase().includes(q))
  }, [files, filesFilter, localSearch, starred])

  const refresh = async () => {
    const result = await rpc.request(RpcCommand.LIST_TRANSFERS)
    setHistory(result.transfers || [])
    setHostHistory((prev) => mergeHostHistory(prev, result.transfers || []))
  }

  const refreshHosts = async () => {
    const result = await rpc.request(RpcCommand.LIST_ACTIVE_HOSTS)
    setActiveHosts(result.hosts || [])
  }

  const onUpload = async () => {
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
        payloadFiles.push({
          id: `local:${Date.now()}:${asset.name}`,
          name: asset.name,
          byteLength: Number(asset.size || 0),
          updatedAt: now,
          source: 'local',
          invite: '',
          path: asset.uri,
          mimeType: asset.mimeType || guessMime(asset.name)
        })
        upsertWorkerActivityBar('ingest', 'Loading files...', i + 1, pick.assets.length)
        if ((i + 1) % 20 === 0) await sleep(0)
      }
      setFiles((prev) => [...payloadFiles, ...prev])
      setStatus(`Added ${payloadFiles.length} file(s). Select and tap Host Upload.`)
      setWorkerLogMessage('file indexing complete')
    } catch (error: any) {
      Alert.alert('Upload failed', error?.message || String(error))
    } finally {
      clearWorkerActivityBar('ingest')
    }
  }

  const onHostSelected = async (sessionNameRaw: string) => {
    if (hostingBusy) return
    const sessionName = String(sessionNameRaw || '').trim() || 'Host Session'
    const picked = files.filter((item) => selected.has(item.id))
    if (!picked.length) {
      Alert.alert('Select files', 'Select one or more files first.')
      return
    }

    const payload = (
      await Promise.all(picked.map((item) => toUploadPayload(item, rpc, setFiles)))
    ).filter(Boolean)

    if (!payload.length) {
      Alert.alert('Not hostable', 'Selected files are not available locally for hosting.')
      return
    }

    try {
      setHostingBusy(true)
      upsertWorkerActivityBar('host', 'Preparing selected files...', 1, 4)
      setStatus(`Hosting ${payload.length} selected file(s)...`)
      setWorkerLogMessage('creating host session')
      upsertWorkerActivityBar('host', 'Starting host session...', 2, 4)
      const result = await rpc.request(RpcCommand.CREATE_UPLOAD, { files: payload, sessionName })
      upsertWorkerActivityBar('host', 'Generating invite...', 3, 4)
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
          manifest: result?.manifest || [],
          invite: result?.nativeInvite || result?.invite || '',
          totalBytes: payload.reduce((sum, item: any) => sum + Number(item?.byteLength || 0), 0),
          fileCount: payload.length
        })
      )
      const invite = result.nativeInvite || result.invite
      setLatestInvite(invite)
      setFiles((prev) =>
        prev.map((item) =>
          selected.has(item.id)
            ? {
                ...item,
                source: 'upload',
                invite,
                updatedAt: Date.now()
              }
            : item
        )
      )
      upsertWorkerActivityBar('host', 'Host ready', 4, 4)
      setStatus('upload host created.')
      setWorkerLogMessage('host session ready')
      await Promise.all([refresh(), refreshHosts()])
    } catch (error: any) {
      setWorkerLogMessage(`host upload failed - ${error?.message || String(error)}`)
      Alert.alert('Host failed', error?.message || String(error))
    } finally {
      setHostingBusy(false)
      setTimeout(() => clearWorkerActivityBar('host'), 700)
    }
  }

  const startHostNamePromptForSelected = () => {
    if (hostingBusy) return
    setPendingHostMode('selected')
    setHostNameDraft('Host Session')
    setHostNameModalVisible(true)
  }

  const restartHostFromHistory = async (item: any) => {
    const transferId = String(item?.id || item?.transferId || '').trim()
    if (!transferId) return
    const sessionName =
      String(item?.sessionName || item?.sessionLabel || 'Host Session').trim() || 'Host Session'
    try {
      setHostingBusy(true)
      upsertWorkerActivityBar('host', 'Starting host session...', 1, 3)
      setStatus('Starting host from history...')
      setWorkerLogMessage('starting host from history')
      const result = await rpc.request(RpcCommand.START_HOST_FROM_TRANSFER, {
        transferId,
        sessionName
      })
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
      setHostHistory((prev) =>
        rememberHostHistory(prev, result?.transfer, {
          sessionName,
          manifest: result?.manifest || [],
          invite: result?.nativeInvite || result?.invite || ''
        })
      )
      const invite = result.nativeInvite || result.invite || ''
      if (invite) {
        setLatestInvite(invite)
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
    } catch (error: any) {
      setWorkerLogMessage(`host from history failed - ${error?.message || String(error)}`)
      Alert.alert('Host failed', error?.message || String(error))
    } finally {
      setHostingBusy(false)
      setTimeout(() => clearWorkerActivityBar('host'), 700)
    }
  }

  const submitHostNameModal = async () => {
    const sessionName = String(hostNameDraft || '').trim() || 'Host Session'
    setHostNameModalVisible(false)
    try {
      if (pendingHostMode === 'selected') {
        await onHostSelected(sessionName)
        return
      }
    } catch (error: any) {
      setWorkerLogMessage(`host from history failed - ${error?.message || String(error)}`)
      Alert.alert('Host failed', error?.message || String(error))
    } finally {
      setHostingBusy(false)
      setTimeout(() => clearWorkerActivityBar('host'), 700)
      setPendingHostMode('')
    }
  }

  const dismissHostNameModal = () => {
    setHostNameModalVisible(false)
    setPendingHostMode('')
  }

  const onDownload = async () => {
    const invite = extractInviteUrl(inviteInput.trim())
    if (!invite) {
      Alert.alert('Invite required', 'Paste a valid invite link first.')
      return
    }

    try {
      setStatus('Loading invite files...')
      setWorkerLogMessage('loading invite manifest')
      const manifest = await rpc.request(RpcCommand.GET_MANIFEST, { invite })
      const entries = Array.isArray(manifest.files) ? manifest.files : []
      setInviteSource(invite)
      setInviteEntries(entries)
      setInviteSelected(
        new Set(entries.map((item: InviteEntry) => String(item.drivePath || item.name)))
      )
      setInviteMode(true)
      setStatus(`Loaded ${entries.length} invite file(s)`)
      setWorkerLogMessage('invite manifest loaded')
    } catch (error: any) {
      setWorkerLogMessage(`invite load failed - ${error?.message || String(error)}`)
      Alert.alert('Invite load failed', error?.message || String(error))
    }
  }

  const onShareInvite = async () => {
    if (!latestInvite) {
      Alert.alert('No invite', 'Create an upload first to share an invite.')
      return
    }

    const nativeInvite = extractInviteUrl(latestInvite)
    const shareLink = nativeInvite
      ? `${PUBLIC_SITE_ORIGIN}/open/?invite=${encodeURIComponent(nativeInvite)}`
      : latestInvite
    const message = shareLink

    await Share.share({
      message,
      url: shareLink,
      title: 'Pear Drop invite'
    })
  }

  const copyInviteIntoDownload = (invite: string) => {
    const value = extractInviteUrl(invite)
    if (!value) return
    setInviteInput(value)
    setLatestInvite(value)
    setMainTab('download')
    setStatus('Invite copied to Download tab.')
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

  const downloadInviteSelected = async (mode: 'download' | 'add-selected') => {
    const selectedEntries = inviteEntries.filter((entry) =>
      inviteSelected.has(String(entry.drivePath || entry.name))
    )
    const picked = selectedEntries
    if (!picked.length) {
      Alert.alert('Select files', 'Select one or more drive files first.')
      return
    }
    const shouldDownload = mode === 'download'
    const shouldAddToApp = mode === 'add-selected'
    setStatus(
      shouldDownload
        ? `Downloading ${picked.length} file(s)...`
        : `Adding ${picked.length} selected file(s) to app...`
    )
    setWorkerLogMessage(
      shouldDownload ? 'downloading selected invite files' : 'adding selected drive files to app'
    )
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

    try {
      const now = Date.now()
      const imported: FileRecord[] = []
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
              length: Math.min(256 * 1024, expectedFileBytes - fileDone)
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
            drivePath: entry.drivePath
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

        if (shouldAddToApp) {
          imported.push({
            id: `download:${now}:${i}:${safeName}`,
            name: safeName,
            byteLength: fileDone,
            updatedAt: Date.now(),
            source: 'download',
            invite: inviteSource,
            mimeType: entry.mimeType || 'application/octet-stream',
            dataBase64: ''
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

      if (imported.length) setFiles((prev) => [...imported, ...prev])
      await refresh()
      setStatus(
        shouldDownload
          ? Platform.OS === 'android'
            ? `Downloaded ${picked.length} file(s) to Downloads`
            : `Downloaded ${picked.length} file(s)`
          : `Added ${picked.length} selected file(s) to app`
      )
      setWorkerLogMessage(shouldDownload ? 'download completed' : 'drive files added to app')
    } finally {
      clearWorkerActivityBar('download')
    }
  }

  const removeFilesByIds = (ids: string[]) => {
    const idSet = new Set(ids.map((id) => String(id || '')).filter(Boolean))
    if (!idSet.size) return
    setFiles((prev) => prev.filter((item) => !idSet.has(item.id)))
    setStarred((prev) => {
      const next = new Set(prev)
      for (const id of idSet) next.delete(id)
      return next
    })
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of idSet) next.delete(id)
      return next
    })
  }

  const toggleStar = (id: string) => {
    setStarred((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
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

  const themeModeMeta = {
    system: { icon: '◫', label: 'System' },
    dark: { icon: '◼', label: 'Dark' },
    light: { icon: '◻', label: 'Light' }
  } as const

  const stopActiveHost = async (invite: string) => {
    try {
      await rpc.request(RpcCommand.STOP_HOST, { invite })
      if (hostDetailInvite === invite) setHostDetailInvite('')
      await refreshHosts()
      setStatus('Hosting stopped')
    } catch (error: any) {
      Alert.alert('Stop host failed', error?.message || String(error))
    }
  }

  const removeHistoryItems = (items: any[]) => {
    const keys = items.map((item) => historyEntryKey(item)).filter(Boolean)
    if (!keys.length) return
    const removeSet = new Set(keys)
    setHostHistory((prev) => prev.filter((item) => !removeSet.has(historyEntryKey(item))))
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
    const picked = rows.filter((item) => selectedHostHistory.has(historyEntryKey(item)))
    if (!picked.length) {
      Alert.alert('Select history', 'Select one or more history items first.')
      return
    }
    for (const item of picked) {
      // Keep host restart sequence explicit and stable.
      // eslint-disable-next-line no-await-in-loop
      await restartHostFromHistory(item)
    }
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

  const renderHostContent = () => {
    if (hostDetailInvite) {
      const host = activeHosts.find((item) => item.invite === hostDetailInvite)
      if (!host) {
        return <Text style={[styles.muted, themed.muted]}>Host session is no longer active.</Text>
      }
      const manifest = host.manifest || []
      return (
        <View style={styles.hostSection}>
          <View style={styles.hostDetailHead}>
            <Pressable style={styles.rowBtn} onPress={() => setHostDetailInvite('')}>
              <Text style={styles.rowBtnText}>← Back</Text>
            </Pressable>
            <Text style={styles.hostDetailTitle}>{host.sessionLabel || 'Host session'}</Text>
          </View>
          {manifest.map((entry, idx) => (
            <View key={`${entry.drivePath || entry.name || idx}`} style={styles.hostFileRow}>
              <Text style={styles.fileName}>{entry.name || 'file'}</Text>
              <Text style={styles.fileSub}>
                {formatBytes(Number(entry.byteLength || 0))} • {entry.mimeType || 'file'}
              </Text>
            </View>
          ))}
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
        <Text style={[styles.hostSectionTitle, themed.text]}>Active hosts (online)</Text>
        {activeHosts.length === 0 ? (
          <Text style={[styles.muted, themed.muted]}>No active host sessions.</Text>
        ) : (
          activeHosts.map((host) => (
            <View key={host.invite} style={[styles.hostCard, themed.panel]}>
              <Pressable onPress={() => setHostDetailInvite(host.invite)}>
                <Text style={[styles.hostCardTitle, themed.text]}>
                  {host.sessionLabel || 'Host session'}
                </Text>
              </Pressable>
              <Text style={[styles.fileSub, themed.muted]}>
                {host.fileCount || 0} files • {formatBytes(Number(host.totalBytes || 0))}
              </Text>
              <View style={styles.hostCardActions}>
                <Pressable style={styles.rowBtn} onPress={() => toggleStarHostInvite(host.invite)}>
                  <Text style={styles.rowBtnText}>
                    {starredHosts.has(String(host.invite || '')) ? '★' : '☆'}
                  </Text>
                </Pressable>
                <Pressable style={styles.rowBtn} onPress={() => setHostDetailInvite(host.invite)}>
                  <Text style={styles.rowBtnText}>Open</Text>
                </Pressable>
                <Pressable
                  style={styles.rowBtn}
                  onPress={() => copyInviteIntoDownload(host.invite)}
                >
                  <Text style={styles.rowBtnText}>Copy</Text>
                </Pressable>
                <Pressable style={styles.rowBtn} onPress={() => stopActiveHost(host.invite)}>
                  <Text style={[styles.rowBtnText, styles.rowDeleteText]}>Stop</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}

        <Text style={[styles.hostSectionTitle, themed.text]}>Starred hosts</Text>
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

            return (
              <View key={`starred:${invite}`} style={[styles.hostCard, themed.panel]}>
                <Text style={[styles.hostCardTitle, themed.text]}>
                  {activeHost?.sessionLabel || historyItem?.sessionLabel || 'Starred host'}
                </Text>
                <Text style={[styles.fileSub, themed.muted]}>
                  {canStop
                    ? `${activeHost?.fileCount || 0} files • ${formatBytes(Number(activeHost?.totalBytes || 0))}`
                    : 'Not active'}
                </Text>
                <View style={styles.hostCardActions}>
                  {canStop ? (
                    <Pressable style={styles.rowBtn} onPress={() => void stopActiveHost(invite)}>
                      <Text style={[styles.rowBtnText, styles.rowDeleteText]}>Stop</Text>
                    </Pressable>
                  ) : canRehost ? (
                    <Pressable
                      style={styles.rowBtn}
                      onPress={() => void restartHostFromHistory(historyItem)}
                    >
                      <Text style={styles.rowBtnText}>Re-host</Text>
                    </Pressable>
                  ) : null}
                  <Pressable style={styles.rowBtn} onPress={() => copyInviteIntoDownload(invite)}>
                    <Text style={styles.rowBtnText}>Copy</Text>
                  </Pressable>
                  <Pressable style={styles.rowBtn} onPress={() => toggleStarHostInvite(invite)}>
                    <Text style={styles.rowBtnText}>Unstar</Text>
                  </Pressable>
                </View>
              </View>
            )
          })
        )}

        <Text style={[styles.hostSectionTitle, themed.text]}>History</Text>
        {selectedHostHistory.size > 0 ? (
          <View style={[styles.bulkBar, themed.panel]}>
            <Text style={[styles.bulkText, themed.muted]}>{selectedHostHistory.size} selected</Text>
            <Pressable
              style={styles.rowBtn}
              onPress={() => void startSelectedHistoryHosts(hostHistoryRows)}
            >
              <Text style={styles.rowBtnText}>Start Hosting</Text>
            </Pressable>
            <Pressable
              style={styles.rowBtn}
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
              <Text style={[styles.rowBtnText, styles.rowDeleteText]}>Remove</Text>
            </Pressable>
          </View>
        ) : null}
        {hostHistoryRows.length === 0 ? (
          <Text style={[styles.muted, themed.muted]}>No host history yet.</Text>
        ) : (
          hostHistoryRows.map((item) => {
            const historyKey = historyEntryKey(item)
            const preview = Array.isArray(item.manifest)
              ? item.manifest
                  .slice(0, 2)
                  .map((entry: any) => entry.name)
                  .join(', ')
              : 'No manifest preview'
            return (
              <View
                key={historyKey || String(item.id || item.transferId || Math.random())}
                style={[styles.hostCard, themed.panel]}
              >
                <Text style={[styles.hostCardTitle, themed.text]}>
                  {item.sessionLabel || item.sessionName || item.invite || 'Upload history'}
                </Text>
                <Text style={[styles.fileSub, themed.muted]}>
                  {preview || 'No manifest preview'}
                </Text>
                <View style={styles.hostCardActions}>
                  <Pressable style={styles.rowBtn} onPress={() => toggleSelectHostHistory(item)}>
                    <Text style={styles.rowBtnText}>
                      {selectedHostHistory.has(historyKey) ? '☑' : '☐'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.rowBtn}
                    onPress={() => void restartHostFromHistory(item)}
                  >
                    <Text style={styles.rowBtnText}>Start hosting</Text>
                  </Pressable>
                  <Pressable
                    style={styles.rowBtn}
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
                    <Text style={[styles.rowBtnText, styles.rowDeleteText]}>Remove</Text>
                  </Pressable>
                  {item.invite ? (
                    <Pressable
                      style={styles.rowBtn}
                      onPress={() => copyInviteIntoDownload(item.invite)}
                    >
                      <Text style={styles.rowBtnText}>Copy invite</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            )
          })
        )}
      </View>
    )
  }

  const renderInviteList = () => {
    const allSelected =
      inviteEntries.length > 0 &&
      inviteEntries.every((entry) => inviteSelected.has(String(entry.drivePath || entry.name)))

    return (
      <View style={styles.hostSection}>
        <View style={styles.hostDetailHead}>
          <Pressable
            style={styles.rowBtn}
            onPress={() => {
              setInviteMode(false)
              setInviteEntries([])
              setInviteSelected(new Set())
            }}
          >
            <Text style={styles.rowBtnText}>← Back</Text>
          </Pressable>
          <Text style={styles.hostDetailTitle}>View drive</Text>
        </View>
        <View style={[styles.bulkBar, themed.panel]}>
          <Pressable style={styles.rowBtn} onPress={toggleInviteSelectAll}>
            <Text style={styles.rowBtnText}>{allSelected ? '☑' : '☐'}</Text>
          </Pressable>
          <Text style={[styles.bulkText, themed.muted]}>
            {
              inviteEntries.filter((entry) =>
                inviteSelected.has(String(entry.drivePath || entry.name))
              ).length
            }{' '}
            selected
          </Text>
          <Pressable style={styles.rowBtn} onPress={() => void downloadInviteSelected('download')}>
            <Text style={styles.rowBtnText}>Download</Text>
          </Pressable>
          <Pressable
            style={styles.rowBtn}
            onPress={() => void downloadInviteSelected('add-selected')}
          >
            <Text style={styles.rowBtnText}>Add Selected</Text>
          </Pressable>
        </View>
        {inviteEntries.map((entry, i) => {
          const key = String(entry.drivePath || entry.name)
          const selectedRow = inviteSelected.has(key)
          return (
            <View key={`${key}:${i}`} style={[styles.fileRow, themed.panel]}>
              <Pressable onPress={() => toggleInviteSelect(entry)} style={styles.checkBtn}>
                <Text style={styles.checkText}>{selectedRow ? '☑' : '☐'}</Text>
              </Pressable>
              <View style={styles.previewBox}>
                <Text style={styles.previewText}>
                  {fileExt(entry.name || '').toUpperCase() || 'FILE'}
                </Text>
              </View>
              <View style={styles.fileMeta}>
                <Text style={[styles.fileName, themed.text]}>{entry.name || `File ${i + 1}`}</Text>
                <Text style={[styles.fileSub, themed.muted]}>
                  {formatBytes(Number(entry.byteLength || 0))}
                </Text>
              </View>
              <Pressable
                style={styles.rowBtn}
                onPress={async () => {
                  setInviteSelected(new Set([key]))
                  await downloadInviteSelected('download')
                }}
              >
                <Text style={styles.rowBtnText}>↓</Text>
              </Pressable>
            </View>
          )
        })}
      </View>
    )
  }

  const renderFileList = () => {
    if (!visibleFiles.length) {
      return <Text style={[styles.muted, themed.muted]}>No files in this section yet.</Text>
    }

    return visibleFiles.map((item) => {
      const isStarred = starred.has(item.id)
      const isSelected = selected.has(item.id)
      const isImage = String(item.mimeType || '').startsWith('image/') && item.dataBase64
      const isVideo = String(item.mimeType || '').startsWith('video/')
      return (
        <View key={item.id} style={[styles.fileRow, themed.panel]}>
          <Pressable onPress={() => toggleSelect(item.id)} style={styles.checkBtn}>
            <Text style={styles.checkText}>{isSelected ? '☑' : '☐'}</Text>
          </Pressable>
          <Pressable
            style={styles.previewBox}
            onPress={() => {
              setPreviewFile(item)
              previewTranslateY.setValue(0)
            }}
          >
            {isImage ? (
              <Image
                source={{ uri: `data:${item.mimeType};base64,${item.dataBase64}` }}
                style={styles.previewImage}
              />
            ) : (
              <Text style={styles.previewText}>
                {isVideo ? '▶' : fileExt(item.name).toUpperCase() || 'FILE'}
              </Text>
            )}
          </Pressable>
          <View style={styles.fileMeta}>
            <Text style={[styles.fileName, themed.text]}>{item.name}</Text>
            <Text style={[styles.fileSub, themed.muted]}>
              {formatBytes(item.byteLength)} • {formatDate(item.updatedAt)} • {item.source}
            </Text>
          </View>
          <View style={styles.fileActions}>
            <Pressable onPress={() => toggleStar(item.id)} style={styles.rowBtn}>
              <Text style={styles.rowBtnText}>{isStarred ? '★' : '☆'}</Text>
            </Pressable>
            <Pressable
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
              style={styles.rowBtn}
            >
              <TrashIcon />
            </Pressable>
          </View>
        </View>
      )
    })
  }

  const renderWorkerPanel = () => (
    <View style={[styles.activityPanel, themed.panel]}>
      <Text style={[styles.status, themed.muted]}>{status}</Text>
      <Text style={[styles.workerLog, themed.muted]}>{workerLog}</Text>
      {workerActivityBars.map((bar) => (
        <View key={bar.id} style={styles.ingestWrap}>
          <Text style={[styles.ingestLabel, themed.muted]}>
            {bar.label}{' '}
            {bar.displayMode === 'bytes'
              ? `${Math.round((bar.done / Math.max(bar.total, 1)) * 100)}% (${formatBytes(bar.done)} / ${formatBytes(bar.total)})`
              : `${bar.done}/${Math.max(bar.total, 1)}`}
          </Text>
          {bar.subtitle ? (
            <Text style={[styles.ingestSubLabel, themed.muted]}>{bar.subtitle}</Text>
          ) : null}
          <View style={[styles.ingestTrack, themed.panelSoft]}>
            <View
              style={[
                styles.ingestFill,
                themed.accentBg,
                { width: `${Math.round((bar.done / Math.max(bar.total, 1)) * 100)}%` }
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  )

  return (
    <SafeAreaView style={[styles.container, themed.container]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      <View style={[styles.topHeader, themed.container]}>
        <Text style={[styles.topTitle, themed.text]}>Pear Drop</Text>
      </View>

      <View style={styles.themeModeRow}>
        <Pressable
          style={[styles.themeDropdownBtn, themed.panelSoft]}
          onPress={() => setThemeDropdownOpen(true)}
        >
          <View style={styles.themeLabelRow}>
            <View style={[styles.themeIconBadge, themed.iconBadge]}>
              <Text style={[styles.themeGlyph, themed.muted]}>{themeModeMeta[themeMode].icon}</Text>
            </View>
            <Text style={[styles.themeDropdownText, themed.text]}>
              {themeModeMeta[themeMode].label}
            </Text>
          </View>
          <Text style={[styles.themeDropdownChevron, themed.muted]}>▾</Text>
        </Pressable>
      </View>

      <View style={styles.mainTabsRow}>
        <Pressable
          style={[
            styles.mainTabBtn,
            themed.panelSoft,
            mainTab === 'upload' && styles.mainTabBtnActive,
            mainTab === 'upload' && themed.accentBg
          ]}
          onPress={() => setMainTab('upload')}
        >
          <Text
            style={[styles.mainTabBtnText, mainTab === 'upload' && styles.mainTabBtnTextActive]}
          >
            Upload
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.mainTabBtn,
            themed.panelSoft,
            mainTab === 'download' && styles.mainTabBtnActive,
            mainTab === 'download' && themed.accentBg
          ]}
          onPress={() => setMainTab('download')}
        >
          <Text
            style={[styles.mainTabBtnText, mainTab === 'download' && styles.mainTabBtnTextActive]}
          >
            Download
          </Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {mainTab === 'upload' ? (
          <>
            <TextInput
              value={localSearch}
              onChangeText={setLocalSearch}
              placeholder='Search local files'
              placeholderTextColor={theme.inputPlaceholder}
              style={[styles.searchInput, themed.searchInput]}
            />
            <Text style={[styles.filesTitle, themed.text]}>
              {filesFilter === 'all'
                ? 'All Files'
                : filesFilter === 'starred'
                  ? 'Starred'
                  : hostDetailInvite
                    ? 'Host Details'
                    : 'Hosts'}
            </Text>

            <View style={styles.inlineActions}>
              <Pressable style={[styles.primaryBtn, themed.accentBg]} onPress={onUpload}>
                <Text style={styles.primaryBtnText}>Add Files</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.secondaryBtn,
                  themed.panelSoft,
                  hostingBusy && styles.rowBtnDisabled
                ]}
                onPress={startHostNamePromptForSelected}
                disabled={hostingBusy || selected.size === 0}
              >
                <Text style={[styles.secondaryBtnText, themed.text]}>
                  {hostingBusy ? 'Starting...' : 'Host Selected'}
                </Text>
              </Pressable>
              <Pressable style={[styles.secondaryBtn, themed.panelSoft]} onPress={onShareInvite}>
                <Text style={[styles.secondaryBtnText, themed.text]}>Share Invite</Text>
              </Pressable>
            </View>

            {selected.size > 0 && filesFilter !== 'host' ? (
              <View style={styles.bulkBar}>
                <Text style={styles.bulkText}>{selected.size} selected</Text>
                <Pressable
                  style={[styles.rowBtn, hostingBusy && styles.rowBtnDisabled]}
                  onPress={startHostNamePromptForSelected}
                  disabled={hostingBusy}
                >
                  <Text style={styles.rowBtnText}>{hostingBusy ? '…' : '🔗'}</Text>
                </Pressable>
                <Pressable
                  style={styles.rowBtn}
                  onPress={() => {
                    setStarred((prev) => {
                      const next = new Set(prev)
                      const ids = Array.from(selected)
                      const unstar = ids.length > 0 && ids.every((id) => next.has(id))
                      for (const id of ids) {
                        if (unstar) next.delete(id)
                        else next.add(id)
                      }
                      return next
                    })
                  }}
                >
                  <Text style={styles.rowBtnText}>★</Text>
                </Pressable>
                <Pressable
                  style={styles.rowBtn}
                  onPress={() => {
                    Alert.alert(
                      'Remove selected?',
                      `Remove ${selected.size} file(s) from app history?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () => {
                            const ids = Array.from(selected)
                            removeFilesByIds(ids)
                          }
                        }
                      ]
                    )
                  }}
                >
                  <TrashIcon />
                </Pressable>
              </View>
            ) : null}

            {renderWorkerPanel()}

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {(['all', 'starred', 'host'] as FilesFilter[]).map((filter) => (
                <Pressable
                  key={filter}
                  style={[
                    styles.chip,
                    themed.panelSoft,
                    filesFilter === filter && styles.chipActive,
                    filesFilter === filter && themed.accentBg
                  ]}
                  onPress={() => {
                    setFilesFilter(filter)
                    setSelectedHostHistory(new Set())
                    if (filter !== 'host') setHostDetailInvite('')
                    if (filter === 'host') void refreshHosts()
                  }}
                >
                  <Text
                    style={[
                      styles.chipText,
                      themed.muted,
                      filesFilter === filter && styles.chipTextActive
                    ]}
                  >
                    {filter === 'all' ? 'All' : filter === 'starred' ? 'Starred' : 'Hosts'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.filesList}>
              {filesFilter === 'host' ? renderHostContent() : renderFileList()}
            </View>
          </>
        ) : (
          <>
            <TextInput
              value={inviteInput}
              onChangeText={setInviteInput}
              placeholder='Paste peardrops://invite...'
              placeholderTextColor={theme.inputPlaceholder}
              style={[styles.searchInput, themed.searchInput]}
            />
            <View style={styles.inlineActions}>
              <Pressable style={[styles.primaryBtn, themed.accentBg]} onPress={onDownload}>
                <Text style={styles.primaryBtnText}>View Drive</Text>
              </Pressable>
              {inviteMode ? (
                <Pressable
                  style={[styles.secondaryBtn, themed.panelSoft]}
                  onPress={() => void downloadInviteSelected('download')}
                >
                  <Text style={[styles.secondaryBtnText, themed.text]}>Download Selected</Text>
                </Pressable>
              ) : null}
            </View>

            {renderWorkerPanel()}

            <View style={styles.filesList}>
              {inviteMode ? (
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
        visible={themeDropdownOpen}
        transparent
        animationType='fade'
        onRequestClose={() => setThemeDropdownOpen(false)}
      >
        <View style={styles.themeModalRoot}>
          <Pressable
            style={styles.folderModalBackdrop}
            onPress={() => setThemeDropdownOpen(false)}
          />
          <View style={[styles.themeDropdownCard, themed.panel]}>
            {(['system', 'dark', 'light'] as ThemeMode[]).map((mode) => (
              <Pressable
                key={mode}
                style={[
                  styles.themeDropdownOption,
                  themed.panelSoft,
                  mode === themeMode && styles.themeDropdownOptionActive
                ]}
                onPress={() => {
                  setThemeMode(mode)
                  setThemeDropdownOpen(false)
                }}
              >
                <View style={styles.themeOptionRow}>
                  <View style={styles.themeLabelRow}>
                    <View style={[styles.themeIconBadge, themed.iconBadge]}>
                      <Text style={[styles.themeGlyph, themed.muted]}>
                        {themeModeMeta[mode].icon}
                      </Text>
                    </View>
                    <Text style={[styles.themeDropdownOptionText, themed.text]}>
                      {themeModeMeta[mode].label}
                    </Text>
                  </View>
                  {mode === themeMode ? (
                    <Text style={[styles.themeOptionCheck, themed.text]}>✓</Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>

      <Modal
        visible={hostNameModalVisible}
        transparent
        animationType='fade'
        onRequestClose={dismissHostNameModal}
      >
        <View style={styles.folderModalRoot}>
          <Pressable style={styles.folderModalBackdrop} onPress={dismissHostNameModal} />
          <View style={[styles.folderModalCard, themed.panel]}>
            <Text style={[styles.folderModalTitle, themed.text]}>Host session name</Text>
            <Text style={[styles.muted, themed.muted]}>
              Final session label: name + date + 4-char random hex.
            </Text>
            <TextInput
              value={hostNameDraft}
              onChangeText={setHostNameDraft}
              placeholder='Host Session'
              style={[styles.folderInput, themed.panelSoft]}
            />
            <View style={styles.folderModalActions}>
              <Pressable style={[styles.rowBtn, themed.panelSoft]} onPress={dismissHostNameModal}>
                <Text style={styles.rowBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, themed.accentBg]}
                onPress={() => void submitHostNameModal()}
              >
                <Text style={styles.primaryBtnText}>Start</Text>
              </Pressable>
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

function TrashIcon() {
  return (
    <View style={styles.trashIcon}>
      <View style={styles.trashLid} />
      <View style={styles.trashBody}>
        <View style={styles.trashLine} />
        <View style={styles.trashLine} />
      </View>
    </View>
  )
}

function PreviewModal({
  file,
  translateY,
  onClose
}: {
  file: FileRecord | null
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
  const isImage = !!file?.dataBase64 && String(file?.mimeType || '').startsWith('image/')
  const isVideo = !!file?.dataBase64 && String(file?.mimeType || '').startsWith('video/')

  return (
    <Modal visible={visible} transparent animationType='fade' onRequestClose={onClose}>
      <View style={styles.previewModalRoot}>
        <Pressable style={styles.previewBackdrop} onPress={onClose} />
        <Animated.View
          style={[styles.previewSheet, { transform: [{ translateY }] }]}
          {...panResponder.panHandlers}
        >
          <View style={styles.previewSheetHead}>
            <Text style={styles.previewSheetTitle}>{file?.name || ''}</Text>
            <Pressable onPress={onClose} style={styles.previewCloseBtn}>
              <Text style={styles.previewCloseText}>✕</Text>
            </Pressable>
          </View>
          <View style={styles.previewSheetBody}>
            {isImage ? (
              <Image
                source={{ uri: `data:${file?.mimeType};base64,${file?.dataBase64}` }}
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
      starred: Array.isArray(parsed.starred) ? parsed.starred : [],
      starredHosts: Array.isArray(parsed.starredHosts) ? parsed.starredHosts : [],
      hostHistory: Array.isArray(parsed.hostHistory) ? parsed.hostHistory : [],
      hostHistoryRemoved: Array.isArray(parsed.hostHistoryRemoved) ? parsed.hostHistoryRemoved : [],
      themeMode:
        parsed.themeMode === 'dark' || parsed.themeMode === 'light' || parsed.themeMode === 'system'
          ? parsed.themeMode
          : 'system'
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
      map.set(key, normalized)
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
  return {
    ...entry,
    type: 'upload',
    transferId: transferId || String(entry.id || ''),
    invite,
    sessionName: String(entry.sessionName || fallback.sessionName || 'Host Session'),
    sessionLabel: String(
      entry.sessionLabel || fallback.sessionLabel || entry.sessionName || fallback.sessionName || ''
    ),
    createdAt: Number(entry.createdAt || fallback.createdAt || Date.now()),
    totalBytes: Number(entry.totalBytes || fallback.totalBytes || 0),
    fileCount: Number(entry.fileCount || fallback.fileCount || manifest.length || 0),
    manifest
  }
}

function historyEntryKey(entry: any): string {
  if (!entry || typeof entry !== 'object') return ''
  return String(entry.transferId || entry.id || entry.invite || '').trim()
}

async function toUploadPayload(
  item: FileRecord,
  rpc: { request: (command: number, payload?: any) => Promise<any> },
  setFiles: (updater: (prev: FileRecord[]) => FileRecord[]) => void
) {
  const mimeType = item.mimeType || guessMime(item.name)

  if (typeof item.dataBase64 === 'string') {
    return {
      name: item.name,
      mimeType,
      dataBase64: item.dataBase64
    }
  }

  const localPath = String(item.path || '').trim()
  if (localPath) {
    try {
      const dataBase64 = await FileSystem.readAsStringAsync(localPath, {
        encoding: FileSystem.EncodingType.Base64
      })
      if (dataBase64) {
        setFiles((prev) =>
          prev.map((entry) =>
            entry.id === item.id ? { ...entry, dataBase64, mimeType, path: localPath } : entry
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

async function savePersistedMetadata(payload: PersistedMetadata): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(METADATA_PATH, JSON.stringify(payload), {
      encoding: FileSystem.EncodingType.UTF8
    })
  } catch {
    // Ignore write failures for now; worker transfer state remains intact.
  }
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

async function requestInitWithRetry(
  rpc: { request: (command: number, payload?: any) => Promise<any> },
  attempts: number
) {
  let lastError: any = null
  for (let i = 1; i <= attempts; i++) {
    try {
      return await withTimeout(rpc.request(RpcCommand.INIT), 20000, 'Worker init RPC timed out')
    } catch (error) {
      lastError = error
      if (i < attempts) await sleep(750)
    }
  }
  throw lastError || new Error('Worker init failed')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function fileExt(name: string) {
  const idx = String(name || '').lastIndexOf('.')
  if (idx < 0) return ''
  return String(name).slice(idx + 1)
}

function guessMime(name: string) {
  const ext = fileExt(name).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  return 'application/octet-stream'
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
    justifyContent: 'space-between'
  },
  topTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#121212'
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
  themeModeRow: {
    marginTop: 2,
    marginHorizontal: 16,
    flexDirection: 'row',
    gap: 8
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
    borderColor: '#0f68f5'
  },
  mainTabBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#607086'
  },
  mainTabBtnTextActive: {
    color: '#fff'
  },
  themeDropdownBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#d8dce3',
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  themeDropdownText: {
    color: '#2a3548',
    fontWeight: '600',
    fontSize: 14
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
  themeDropdownChevron: {
    fontSize: 14
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
    borderColor: '#4b6ea8'
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
    marginTop: 8
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
    backgroundColor: '#fff',
    padding: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8
  },
  activityPanel: {
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#d9d9d9',
    borderRadius: 14,
    backgroundColor: '#fff',
    padding: 12,
    gap: 5
  },
  ingestWrap: {
    marginTop: 4
  },
  ingestLabel: {
    fontSize: 12,
    marginBottom: 4
  },
  ingestSubLabel: {
    fontSize: 11,
    opacity: 0.9,
    marginBottom: 4
  },
  ingestTrack: {
    width: '100%',
    height: 8,
    borderRadius: 999,
    overflow: 'hidden'
  },
  ingestFill: {
    height: '100%',
    width: '0%'
  },
  bulkText: {
    color: '#636363',
    marginRight: 8
  },
  primaryBtn: {
    backgroundColor: '#0f68f5',
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
    color: '#0f68f5',
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
    backgroundColor: '#0f68f5'
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
    marginTop: 8,
    marginHorizontal: 16,
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
    gap: 10
  },
  hostSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f1f1f',
    marginTop: 4
  },
  hostCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d8dce3',
    padding: 12,
    gap: 6
  },
  hostCardTitle: {
    fontWeight: '700',
    color: '#1f1f1f'
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
  rowBtnDisabled: {
    opacity: 0.5
  },
  trashIcon: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'flex-start'
  },
  trashLid: {
    width: 10,
    height: 2,
    backgroundColor: '#c44949',
    borderRadius: 1,
    marginBottom: 1
  },
  trashBody: {
    width: 9,
    height: 9,
    borderWidth: 1.5,
    borderColor: '#c44949',
    borderRadius: 1.5,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 1
  },
  trashLine: {
    width: 1.2,
    height: 5.2,
    backgroundColor: '#c44949',
    marginTop: 1
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
  status: {
    color: '#6f6f6f',
    fontSize: 12,
    fontWeight: '600'
  },
  workerLog: {
    color: '#6f6f6f',
    fontSize: 12
  },
  fab: {
    position: 'absolute',
    right: 18,
    bottom: 84,
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: '#0f68f5',
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
  }
})
