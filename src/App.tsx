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

type Tab = 'home' | 'files' | 'photos'
type FilesFilter = 'all' | 'recent' | 'starred' | 'host' | 'deleted'
type HomeSection = 'recent' | 'starred' | 'host'
type ThemeMode = 'system' | 'dark' | 'light'

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
  folderId?: string
  deleted?: boolean
}

type FolderRecord = {
  id: string
  name: string
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
const ANDROID_DOWNLOADS_FILE_URI = 'file:///storage/emulated/0/Download'
let androidDownloadsDirUriCache = ''

type PersistedMetadata = {
  files: FileRecord[]
  starred: string[]
  deleted: string[]
  deletedAt: Record<string, number>
  folders: FolderRecord[]
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
      background: '#121212',
      panel: '#171717',
      panelSoft: '#1f1f1f',
      border: '#323232',
      text: '#f1f3f4',
      muted: '#a4a7ad',
      accent: '#2f7df6',
      danger: '#ff7b7b',
      inputPlaceholder: '#7f8794'
    }
  }
  return {
    background: '#f4f5f7',
    panel: '#ffffff',
    panelSoft: '#f2f4f8',
    border: '#d8dce3',
    text: '#171a21',
    muted: '#5e6675',
    accent: '#2f7df6',
    danger: '#c44949',
    inputPlaceholder: '#7f8794'
  }
}

export default function App() {
  const systemScheme = useColorScheme()
  const [status, setStatus] = useState('Starting worker...')
  const [workerLog, setWorkerLog] = useState('Worker logs: waiting for events.')
  const [activeTab, setActiveTab] = useState<Tab>('home')
  const [filesFilter, setFilesFilter] = useState<FilesFilter>('all')
  const [search, setSearch] = useState('')
  const [latestInvite, setLatestInvite] = useState('')
  const [history, setHistory] = useState<any[]>([])
  const [hostHistory, setHostHistory] = useState<any[]>([])
  const [hostHistoryRemoved, setHostHistoryRemoved] = useState<Set<string>>(new Set())
  const [selectedHostHistory, setSelectedHostHistory] = useState<Set<string>>(new Set())
  const [activeHosts, setActiveHosts] = useState<ActiveHost[]>([])
  const [hostDetailInvite, setHostDetailInvite] = useState('')
  const [files, setFiles] = useState<FileRecord[]>([])
  const [starred, setStarred] = useState<Set<string>>(new Set())
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const [deletedAt, setDeletedAt] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [folders, setFolders] = useState<FolderRecord[]>([])
  const [folderFilter, setFolderFilter] = useState('')
  const [recentVisible, setRecentVisible] = useState(10)
  const [deletedVisible, setDeletedVisible] = useState(10)
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null)
  const [metadataLoaded, setMetadataLoaded] = useState(false)
  const [folderModalVisible, setFolderModalVisible] = useState(false)
  const [folderDraftName, setFolderDraftName] = useState('')
  const [folderAssignIds, setFolderAssignIds] = useState<string[]>([])
  const [hostNameModalVisible, setHostNameModalVisible] = useState(false)
  const [hostNameDraft, setHostNameDraft] = useState('Host Session')
  const [pendingHostMode, setPendingHostMode] = useState<'selected' | ''>('')
  const [inviteMode, setInviteMode] = useState(false)
  const [inviteSource, setInviteSource] = useState('')
  const [inviteEntries, setInviteEntries] = useState<InviteEntry[]>([])
  const [inviteSelected, setInviteSelected] = useState<Set<string>>(new Set())
  const previewTranslateY = useRef(new Animated.Value(0)).current
  const [fabOpen, setFabOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [homeSections, setHomeSections] = useState<HomeSection[]>(['recent', 'starred', 'host'])
  const [hiddenSections, setHiddenSections] = useState<Set<HomeSection>>(new Set())
  const [hostingBusy, setHostingBusy] = useState(false)
  const [workerActivityBars, setWorkerActivityBars] = useState<WorkerActivityBar[]>([])
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const isDark =
    themeMode === 'system' ? systemScheme !== 'light' : themeMode === 'dark'
  const theme = useMemo(() => getTheme(isDark), [isDark])
  const themed = useMemo(
    () => ({
      container: { backgroundColor: theme.background },
      panel: { backgroundColor: theme.panel, borderColor: theme.border },
      panelSoft: { backgroundColor: theme.panelSoft, borderColor: theme.border },
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
    const text = String(message || '').trim()
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
      setDeleted(new Set(stored.deleted || []))
      setDeletedAt(stored.deletedAt || {})
      setFolders(stored.folders || [])
      setHostHistory(Array.isArray(stored.hostHistory) ? stored.hostHistory : [])
      setHostHistoryRemoved(new Set(Array.isArray(stored.hostHistoryRemoved) ? stored.hostHistoryRemoved : []))
      if (stored.themeMode === 'dark' || stored.themeMode === 'light' || stored.themeMode === 'system') {
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
      deleted: Array.from(deleted),
      deletedAt,
      folders,
      hostHistory: hostHistory.slice(0, 300),
      hostHistoryRemoved: Array.from(hostHistoryRemoved).slice(0, 600),
      themeMode
    }
    void savePersistedMetadata(payload)
  }, [
    files,
    starred,
    deleted,
    deletedAt,
    folders,
    hostHistory,
    hostHistoryRemoved,
    themeMode,
    metadataLoaded
  ])

  useEffect(() => {
    if (!metadataLoaded) return
    const now = Date.now()
    const expiredIds = Array.from(deleted).filter((id) => {
      const ts = Number(deletedAt[id] || 0)
      return ts > 0 && now - ts >= THIRTY_DAYS_MS
    })
    if (!expiredIds.length) return
    const removeSet = new Set(expiredIds)
    setFiles((prev) => prev.filter((item) => !removeSet.has(item.id)))
    setDeleted((prev) => {
      const next = new Set(prev)
      for (const id of expiredIds) next.delete(id)
      return next
    })
    setStarred((prev) => {
      const next = new Set(prev)
      for (const id of expiredIds) next.delete(id)
      return next
    })
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of expiredIds) next.delete(id)
      return next
    })
    setDeletedAt((prev) => {
      const next = { ...prev }
      for (const id of expiredIds) delete next[id]
      return next
    })
  }, [metadataLoaded, deleted, deletedAt])

  useEffect(() => {
    const applyInvite = (url: string | null) => {
      const invite = extractInviteUrl(url)
      if (!invite) return
      setSearch(invite)
      setActiveTab('files')
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
    const q = search.trim().toLowerCase()

    const filtered = files.filter((item) => {
      const deletedMatch = deleted.has(item.id)
      if (filesFilter === 'deleted') return deletedMatch
      if (deletedMatch) return false
      if (folderFilter && item.folderId !== folderFilter) return false

      if (filesFilter === 'recent') return true
      if (filesFilter === 'starred') return starred.has(item.id)
      if (filesFilter === 'host') return item.source === 'upload' || Boolean(item.invite)
      return true
    })

    const sorted = filtered
      .slice()
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(
        0,
        filesFilter === 'recent' ? recentVisible : filesFilter === 'deleted' ? deletedVisible : 200
      )

    if (!q) return sorted
    return sorted.filter((item) => item.name.toLowerCase().includes(q))
  }, [files, filesFilter, search, starred, folderFilter, deleted, recentVisible, deletedVisible])

  const sectionCounts = useMemo(() => {
    const active = files.filter((item) => !deleted.has(item.id))
    return {
      recent: Math.min(10, active.length),
      starred: active.filter((item) => starred.has(item.id)).length,
      host: activeHosts.length
    }
  }, [files, starred, deleted, activeHosts.length])

  const canLoadMoreRecent = useMemo(() => {
    const total = files.filter((item) => !deleted.has(item.id)).length
    return recentVisible < total
  }, [files, deleted, recentVisible])

  const canLoadMoreDeleted = useMemo(() => {
    const total = files.filter((item) => deleted.has(item.id)).length
    return deletedVisible < total
  }, [files, deleted, deletedVisible])

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
      const payloadFiles = []
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
      setFabOpen(false)
    } catch (error: any) {
      Alert.alert('Upload failed', error?.message || String(error))
    } finally {
      clearWorkerActivityBar('ingest')
    }
  }

  const onHostSelected = async (sessionNameRaw: string) => {
    if (hostingBusy) return
    const sessionName = String(sessionNameRaw || '').trim() || 'Host Session'
    const picked = files.filter((item) => selected.has(item.id) && !deleted.has(item.id))
    if (!picked.length) {
      Alert.alert('Select files', 'Select one or more files first.')
      return
    }

    const payload = (
      await Promise.all(picked.map((item) => toUploadPayload(item, rpc, setFiles, deleted)))
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
          selected.has(item.id) && !deleted.has(item.id)
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
      setStatus(`Hosting ready for ${payload.length} file(s).`)
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
        setStatus('Hosting started from history')
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
    const invite = search.trim()
    if (!invite) {
      Alert.alert('Invite required', 'Paste a peardrops://invite URL in search first.')
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

    const message = latestInvite

    await Share.share({
      message,
      url: latestInvite,
      title: 'Pear Drops invite'
    })
  }

  const onSearchAction = async () => {
    const raw = search.trim()
    if (!raw) return
    if (raw.startsWith('peardrops://invite') || raw.startsWith('peardrops-web://join')) {
      await onDownload()
      return
    }
    setInviteMode(false)
    setStatus(`Local search for "${raw}"`)
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

  const downloadInviteSelected = async (
    mode: 'download' | 'add-selected' | 'add-drive-folder'
  ) => {
    const selectedEntries = inviteEntries.filter((entry) =>
      inviteSelected.has(String(entry.drivePath || entry.name))
    )
    const picked = mode === 'add-drive-folder' ? inviteEntries.slice() : selectedEntries
    if (!picked.length) {
      Alert.alert('Select files', 'Select one or more drive files first.')
      return
    }
    const shouldDownload = mode === 'download'
    const shouldAddToApp = mode === 'add-selected' || mode === 'add-drive-folder'
    setStatus(
      shouldDownload
        ? `Downloading ${picked.length} file(s)...`
        : mode === 'add-drive-folder'
          ? `Adding ${picked.length} drive file(s) as folder...`
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
    let folderId = ''
    if (mode === 'add-drive-folder') {
      const folder = {
        id: `folder:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        name: `Drive ${new Date().toLocaleDateString()}`
      }
      setFolders((prev) => [...prev, folder])
      folderId = folder.id
    }

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
            dataBase64: '',
            folderId
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
          : mode === 'add-drive-folder'
            ? `Added drive as folder with ${picked.length} file(s)`
            : `Added ${picked.length} selected file(s) to app`
      )
      setWorkerLogMessage(shouldDownload ? 'download completed' : 'drive files added to app')
    } finally {
      clearWorkerActivityBar('download')
    }
  }

  const openSection = (section: HomeSection) => {
    setActiveTab('files')
    setFilesFilter(section)
    setHostDetailInvite('')
    setSelectedHostHistory(new Set())
    setRecentVisible(10)
    setDeletedVisible(10)
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
    const wasDeleted = deleted.has(id)
    setDeleted((prev) => {
      const next = new Set(prev)
      if (wasDeleted) next.delete(id)
      else next.add(id)
      return next
    })
    setDeletedAt((prev) => {
      const next = { ...prev }
      if (!wasDeleted) next[id] = Date.now()
      else delete next[id]
      return next
    })
    if (!wasDeleted) {
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const assignFolderToSelected = () => {
    const selectedIds = Array.from(selected)
    if (!selectedIds.length) {
      Alert.alert('Select files', 'Select one or more files first.')
      return
    }
    setFolderAssignIds(selectedIds)
    setFolderDraftName('')
    setFolderModalVisible(true)
  }

  const applyFolderName = (nameRaw: string, ids = folderAssignIds) => {
    const name = String(nameRaw || '').trim()
    if (!name || !ids.length) return

    let folder = folders.find((item) => item.name.toLowerCase() === name.toLowerCase())
    if (!folder) {
      folder = {
        id: `folder:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        name
      }
      setFolders((prev) => [...prev, folder!])
    }

    const folderId = folder.id
    const idSet = new Set(ids)
    setFiles((prev) => prev.map((item) => (idSet.has(item.id) ? { ...item, folderId } : item)))
    setFolderModalVisible(false)
    setFolderAssignIds([])
  }

  const removeSelectedFromFolder = () => {
    const ids = Array.from(selected)
    if (!ids.length) return
    const idSet = new Set(ids)
    setFiles((prev) =>
      prev.map((item) => (idSet.has(item.id) ? { ...item, folderId: undefined } : item))
    )
  }

  const deleteCurrentFolder = () => {
    if (!folderFilter) return
    const folder = folders.find((item) => item.id === folderFilter)
    if (!folder) return
    const ids = files.filter((item) => item.folderId === folder.id).map((item) => item.id)
    Alert.alert('Delete folder?', `Delete "${folder.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete Folder',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            'Delete files too?',
            'Also move these files to Deleted files? They can be restored later.',
            [
              {
                text: 'Keep files',
                onPress: () => {
                  const idSet = new Set(ids)
                  setFiles((prev) =>
                    prev.map((item) =>
                      idSet.has(item.id) ? { ...item, folderId: undefined } : item
                    )
                  )
                  setFolders((prev) => prev.filter((item) => item.id !== folder.id))
                  setFolderFilter('')
                }
              },
              {
                text: 'Delete files',
                style: 'destructive',
                onPress: () => {
                  Alert.alert(
                    'Final confirm',
                    'Move selected folder files to Deleted and remove this folder?',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Confirm move',
                        style: 'destructive',
                        onPress: () => {
                          const idSet = new Set(ids)
                          const now = Date.now()
                          setFiles((prev) =>
                            prev.map((item) =>
                              idSet.has(item.id) ? { ...item, folderId: undefined } : item
                            )
                          )
                          setDeleted((prev) => {
                            const next = new Set(prev)
                            for (const id of ids) next.add(id)
                            return next
                          })
                          setDeletedAt((prev) => {
                            const next = { ...prev }
                            for (const id of ids) next[id] = now
                            return next
                          })
                          setFolders((prev) => prev.filter((item) => item.id !== folder.id))
                          setFolderFilter('')
                        }
                      }
                    ]
                  )
                }
              }
            ]
          )
        }
      }
    ])
  }

  const moveSection = (section: HomeSection, direction: -1 | 1) => {
    setHomeSections((prev) => {
      const index = prev.indexOf(section)
      if (index < 0) return prev
      const nextIndex = index + direction
      if (nextIndex < 0 || nextIndex >= prev.length) return prev

      const next = prev.slice()
      const temp = next[index]
      next[index] = next[nextIndex]
      next[nextIndex] = temp
      return next
    })
  }

  const toggleSectionVisibility = (section: HomeSection) => {
    setHiddenSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  const renderHomeSectionCard = (section: HomeSection) => {
    if (hiddenSections.has(section)) return null

    const map = {
      recent: {
        title: 'Recent',
        text: 'Your recently opened files show up here, so you can jump right back in.'
      },
      starred: {
        title: 'Starred',
        text: 'Anything you star shows up here for quick access.'
      },
      host: {
        title: 'Host',
        text: 'Your current host sessions show up here with recent activity below.'
      }
    }[section]

    return (
      <View key={section} style={[styles.homeCard, themed.panel]}>
        <View style={styles.homeCardHead}>
          <Text style={[styles.homeCardTitle, themed.text]}>{map.title}</Text>
          <Pressable onPress={() => openSection(section)}>
            <Text style={[styles.linkText, themed.accentText]}>See all</Text>
          </Pressable>
        </View>
        <Text style={[styles.homeCardText, themed.muted]}>{map.text}</Text>
        <Text style={[styles.homeCardCount, themed.accentText]}>{sectionCounts[section]} items</Text>
      </View>
    )
  }

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
            <Text style={styles.hostDetailTitle}>{host.sessionLabel || host.invite}</Text>
          </View>
          <Text style={styles.muted}>Invite: {host.invite}</Text>
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
                <Text style={[styles.hostCardTitle, themed.text]}>{host.sessionLabel || host.invite}</Text>
              </Pressable>
              <Text style={[styles.fileSub, themed.muted]}>
                {host.fileCount || 0} files • {formatBytes(Number(host.totalBytes || 0))}
              </Text>
              <View style={styles.hostCardActions}>
                <Pressable style={styles.rowBtn} onPress={() => setHostDetailInvite(host.invite)}>
                  <Text style={styles.rowBtnText}>Open</Text>
                </Pressable>
                <Pressable
                  style={styles.rowBtn}
                  onPress={() => {
                    setSearch(host.invite)
                    setLatestInvite(host.invite)
                  }}
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

        <Text style={[styles.hostSectionTitle, themed.text]}>History</Text>
        {selectedHostHistory.size > 0 ? (
          <View style={[styles.bulkBar, themed.panel]}>
            <Text style={[styles.bulkText, themed.muted]}>{selectedHostHistory.size} selected</Text>
            <Pressable style={styles.rowBtn} onPress={() => void startSelectedHistoryHosts(hostHistoryRows)}>
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
              <View key={historyKey || String(item.id || item.transferId || Math.random())} style={[styles.hostCard, themed.panel]}>
                <Text style={[styles.hostCardTitle, themed.text]}>
                  {item.sessionLabel || item.sessionName || item.invite || 'Upload history'}
                </Text>
                <Text style={[styles.fileSub, themed.muted]}>{preview || 'No manifest preview'}</Text>
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
                      onPress={() => {
                        setSearch(item.invite)
                        setLatestInvite(item.invite)
                      }}
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
          <Pressable style={styles.rowBtn} onPress={() => void downloadInviteSelected('add-selected')}>
            <Text style={styles.rowBtnText}>Add Selected</Text>
          </Pressable>
          <Pressable style={styles.rowBtn} onPress={() => void downloadInviteSelected('add-drive-folder')}>
            <Text style={styles.rowBtnText}>Add Drive</Text>
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
                <Text style={[styles.fileSub, themed.muted]}>{formatBytes(Number(entry.byteLength || 0))}</Text>
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
      const folderName = folders.find((folder) => folder.id === item.folderId)?.name || ''
      const isDeleted = deleted.has(item.id)
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
            {folderName ? <Text style={[styles.fileSub, themed.muted]}>Folder: {folderName}</Text> : null}
          </View>
          <View style={styles.fileActions}>
            <Pressable onPress={() => toggleStar(item.id)} style={styles.rowBtn}>
              <Text style={styles.rowBtnText}>{isStarred ? '★' : '☆'}</Text>
            </Pressable>
            {folderName ? (
              <Pressable
                onPress={() =>
                  setFiles((prev) =>
                    prev.map((entry) =>
                      entry.id === item.id ? { ...entry, folderId: undefined } : entry
                    )
                  )
                }
                style={styles.rowBtn}
              >
                <Text style={styles.rowBtnText}>↩︎</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                Alert.alert(
                  isDeleted ? 'Restore file?' : 'Delete file?',
                  isDeleted ? 'Restore this file from deleted?' : 'Move this file to deleted?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Confirm', onPress: () => toggleDelete(item.id) }
                  ]
                )
              }}
              style={styles.rowBtn}
            >
              {isDeleted ? (
                <Text style={[styles.rowBtnText, styles.rowDeleteText]}>↺</Text>
              ) : (
                <TrashIcon />
              )}
            </Pressable>
          </View>
        </View>
      )
    })
  }

  return (
    <View style={[styles.container, themed.container]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      <View style={[styles.topHeader, themed.container]}>
        <Text style={[styles.topTitle, themed.text]}>Home</Text>
        <View style={styles.topIcons}>
          <Text style={styles.topIcon}>🔔</Text>
          <Text style={styles.topIcon}>⇪</Text>
        </View>
      </View>

      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder='Search for files or paste invite to view drive'
        placeholderTextColor={theme.inputPlaceholder}
        style={[styles.searchInput, themed.searchInput]}
      />
      <View style={styles.themeModeRow}>
        {(['system', 'dark', 'light'] as ThemeMode[]).map((mode) => (
          <Pressable
            key={mode}
            style={[
              styles.themeChip,
              themed.panelSoft,
              themeMode === mode && styles.themeChipActive,
              themeMode === mode && themed.accentBg
            ]}
            onPress={() => setThemeMode(mode)}
          >
            <Text
              style={[
                styles.themeChipText,
                themed.muted,
                themeMode === mode && styles.themeChipTextActive
              ]}
            >
              {mode}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {activeTab === 'home' ? (
          <>
            {homeSections.map((section) => renderHomeSectionCard(section))}

            <View style={[styles.customizeCard, themed.panelSoft, { borderColor: theme.border, borderWidth: 1 }]}>
              <Text style={[styles.customizeTitle, themed.text]}>Customize your home screen</Text>
              <Text style={[styles.customizeText, themed.muted]}>
                Add, remove, or reorder sections to show what matters most.
              </Text>
              <Pressable style={[styles.customizeBtn, themed.panel]} onPress={() => setCustomizeOpen((v) => !v)}>
                <Text style={styles.customizeBtnText}>
                  {customizeOpen ? 'Done customizing' : 'Customize'}
                </Text>
              </Pressable>

              {customizeOpen ? (
                <View style={styles.customizePanel}>
                  {homeSections.map((section) => (
                    <View key={`custom-${section}`} style={[styles.customRow, themed.panel]}>
                      <Pressable onPress={() => toggleSectionVisibility(section)}>
                        <Text style={styles.customRowText}>
                          {hiddenSections.has(section) ? 'Show' : 'Hide'} {section}
                        </Text>
                      </Pressable>
                      <View style={styles.customRowActions}>
                        <Pressable
                          onPress={() => moveSection(section, -1)}
                          style={styles.miniControl}
                        >
                          <Text>↑</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => moveSection(section, 1)}
                          style={styles.miniControl}
                        >
                          <Text>↓</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </>
        ) : null}

        {activeTab === 'files' ? (
          <>
            <Text style={[styles.filesTitle, themed.text]}>
              {filesFilter === 'all'
                ? 'All files'
                : filesFilter === 'recent'
                  ? 'Recent'
                  : filesFilter === 'starred'
                    ? 'Starred'
                    : filesFilter === 'host'
                      ? hostDetailInvite
                        ? 'Host details'
                        : 'Host'
                      : 'Deleted'}
            </Text>

            <View style={styles.inlineActions}>
              <Pressable style={[styles.primaryBtn, themed.accentBg]} onPress={onUpload}>
                <Text style={styles.primaryBtnText}>Add Files</Text>
              </Pressable>
              <Pressable style={[styles.secondaryBtn, themed.panelSoft]} onPress={() => void onSearchAction()}>
                <Text style={[styles.secondaryBtnText, themed.accentText]}>Search</Text>
              </Pressable>
              <Pressable style={[styles.secondaryBtn, themed.panelSoft]} onPress={onDownload}>
                <Text style={[styles.secondaryBtnText, themed.accentText]}>View Drive</Text>
              </Pressable>
            </View>

            {selected.size && filesFilter !== 'host' && !inviteMode ? (
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
                    Alert.alert('Delete selected?', `Move ${selected.size} files to deleted?`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        onPress: () => {
                          const ids = Array.from(selected)
                          setDeleted((prev) => {
                            const next = new Set(prev)
                            for (const id of ids) next.add(id)
                            return next
                          })
                          setDeletedAt((prev) => {
                            const next = { ...prev }
                            const now = Date.now()
                            for (const id of ids) next[id] = now
                            return next
                          })
                          setSelected(new Set())
                        }
                      }
                    ])
                  }}
                >
                  <TrashIcon />
                </Pressable>
                <Pressable style={styles.rowBtn} onPress={assignFolderToSelected}>
                  <Text style={styles.rowBtnText}>📁</Text>
                </Pressable>
                {folderFilter ? (
                  <Pressable style={styles.rowBtn} onPress={removeSelectedFromFolder}>
                    <Text style={styles.rowBtnText}>↩︎</Text>
                  </Pressable>
                ) : null}
                {filesFilter === 'deleted' ? (
                  <Pressable
                    style={styles.rowBtn}
                    onPress={() => {
                      const ids = Array.from(selected)
                      if (!ids.length) return
                      Alert.alert(
                        'Wipe selected?',
                        `Permanently remove ${ids.length} selected file(s)?`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Wipe',
                            style: 'destructive',
                            onPress: () => {
                              const idSet = new Set(ids)
                              setFiles((prev) => prev.filter((item) => !idSet.has(item.id)))
                              setDeleted((prev) => {
                                const next = new Set(prev)
                                for (const id of ids) next.delete(id)
                                return next
                              })
                              setStarred((prev) => {
                                const next = new Set(prev)
                                for (const id of ids) next.delete(id)
                                return next
                              })
                              setDeletedAt((prev) => {
                                const next = { ...prev }
                                for (const id of ids) delete next[id]
                                return next
                              })
                              setSelected(new Set())
                            }
                          }
                        ]
                      )
                    }}
                  >
                    <Text style={[styles.rowBtnText, styles.rowDeleteText]}>✖</Text>
                  </Pressable>
                ) : null}
                {filesFilter === 'deleted' ? (
                  <Pressable
                    style={styles.rowBtn}
                    onPress={() => {
                      const ids = Array.from(selected)
                      setDeleted((prev) => {
                        const next = new Set(prev)
                        for (const id of ids) next.delete(id)
                        return next
                      })
                      setDeletedAt((prev) => {
                        const next = { ...prev }
                        for (const id of ids) delete next[id]
                        return next
                      })
                      setSelected(new Set())
                    }}
                  >
                    <Text style={styles.rowBtnText}>↺</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            <View style={[styles.activityPanel, themed.panel]}>
              <View style={[styles.inviteRow, themed.panel]}>
                <Text style={[styles.inviteRowText, themed.text]}>{latestInvite || 'No invite yet'}</Text>
                <Pressable style={[styles.rowBtn, themed.panelSoft]} onPress={onShareInvite}>
                  <Text style={styles.rowBtnText}>⧉</Text>
                </Pressable>
              </View>
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

            {folderFilter && !inviteMode ? (
              <View style={styles.folderActionRow}>
                <Text style={styles.folderActionText}>
                  Folder: {folders.find((item) => item.id === folderFilter)?.name || ''}
                </Text>
                <Pressable style={styles.rowBtn} onPress={deleteCurrentFolder}>
                  <Text style={[styles.rowBtnText, styles.rowDeleteText]}>Delete folder</Text>
                </Pressable>
              </View>
            ) : null}

            {!inviteMode ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
                {(['all', 'recent', 'starred', 'host', 'deleted'] as FilesFilter[]).map(
                  (filter) => (
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
                        setInviteMode(false)
                        setSelectedHostHistory(new Set())
                        if (filter !== 'host') setHostDetailInvite('')
                        if (filter === 'recent') setRecentVisible(10)
                        if (filter === 'deleted') setDeletedVisible(10)
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
                        {filter}
                      </Text>
                    </Pressable>
                  )
                )}
              </ScrollView>
            ) : null}

            {!inviteMode ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
                <Pressable
                  style={[
                    styles.chip,
                    themed.panelSoft,
                    folderFilter === '' && styles.chipActive,
                    folderFilter === '' && themed.accentBg
                  ]}
                  onPress={() => setFolderFilter('')}
                >
                  <Text
                    style={[
                      styles.chipText,
                      themed.muted,
                      folderFilter === '' && styles.chipTextActive
                    ]}
                  >
                    All folders
                  </Text>
                </Pressable>
                {folders.map((folder) => (
                  <Pressable
                    key={folder.id}
                    style={[
                      styles.chip,
                      themed.panelSoft,
                      folderFilter === folder.id && styles.chipActive,
                      folderFilter === folder.id && themed.accentBg
                    ]}
                    onPress={() => setFolderFilter(folder.id)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        themed.muted,
                        folderFilter === folder.id && styles.chipTextActive
                      ]}
                    >
                      {folder.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            <View style={styles.filesList}>
              {inviteMode
                ? renderInviteList()
                : filesFilter === 'host'
                  ? renderHostContent()
                  : renderFileList()}
            </View>

            {!inviteMode &&
              ((filesFilter === 'recent' && canLoadMoreRecent) ||
                (filesFilter === 'deleted' && canLoadMoreDeleted)) && (
                <Pressable
                  style={[styles.secondaryBtn, themed.panelSoft]}
                  onPress={() => {
                    if (filesFilter === 'recent') setRecentVisible((v) => v + 10)
                    else setDeletedVisible((v) => v + 10)
                  }}
                >
                  <Text style={[styles.secondaryBtnText, themed.accentText]}>Load more</Text>
                </Pressable>
              )}
          </>
        ) : null}

        {activeTab === 'photos' ? (
          <View style={[styles.placeholderCard, themed.panel]}>
            <Text style={[styles.placeholderTitle, themed.text]}>Photos</Text>
            <Text style={[styles.muted, themed.muted]}>
              Photo-specific organization is next. Files still remain available in Files.
            </Text>
          </View>
        ) : null}

      </ScrollView>

      {fabOpen ? (
        <View style={[styles.fabMenu, themed.panel]}>
          <Pressable style={[styles.fabItem, themed.panelSoft]} onPress={onUpload}>
            <Text style={[styles.fabItemText, themed.text]}>Upload files</Text>
          </Pressable>
          <Pressable style={[styles.fabItem, themed.panelSoft]} onPress={onDownload}>
            <Text style={[styles.fabItemText, themed.text]}>View drive invite</Text>
          </Pressable>
          <Pressable style={[styles.fabItem, themed.panelSoft]} onPress={onShareInvite}>
            <Text style={[styles.fabItemText, themed.text]}>Share latest invite</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable style={[styles.fab, themed.accentBg]} onPress={() => setFabOpen((v) => !v)}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      <View style={[styles.bottomBar, themed.panel]}>
        {[
          { key: 'home', label: 'Home' },
          { key: 'files', label: 'Files' },
          { key: 'photos', label: 'Photos' }
        ].map((item) => {
          const active = activeTab === item.key
          return (
            <Pressable
              key={item.key}
              style={styles.bottomItem}
              onPress={() => setActiveTab(item.key as Tab)}
            >
              <Text
                style={[
                  styles.bottomText,
                  themed.muted,
                  active && styles.bottomTextActive,
                  active && themed.text
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <Modal
        visible={folderModalVisible}
        transparent
        animationType='fade'
        onRequestClose={() => setFolderModalVisible(false)}
      >
        <View style={styles.folderModalRoot}>
          <Pressable
            style={styles.folderModalBackdrop}
            onPress={() => setFolderModalVisible(false)}
          />
          <View style={[styles.folderModalCard, themed.panel]}>
            <Text style={[styles.folderModalTitle, themed.text]}>Put In Folder</Text>
            <Text style={[styles.muted, themed.muted]}>Select an existing folder or create a new one.</Text>
            <ScrollView style={styles.folderOptionsScroll}>
              {folders.length ? (
                folders.map((folder) => (
                  <Pressable
                    key={folder.id}
                    style={[styles.folderOptionBtn, themed.panelSoft]}
                    onPress={() => applyFolderName(folder.name)}
                  >
                    <Text style={[styles.folderOptionText, themed.text]}>{folder.name}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={[styles.muted, themed.muted]}>No folders yet.</Text>
              )}
            </ScrollView>
            <TextInput
              value={folderDraftName}
              onChangeText={setFolderDraftName}
              placeholder='New folder name'
              style={[styles.folderInput, themed.panelSoft]}
            />
            <View style={styles.folderModalActions}>
              <Pressable style={[styles.rowBtn, themed.panelSoft]} onPress={() => setFolderModalVisible(false)}>
                <Text style={styles.rowBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.primaryBtn, themed.accentBg]} onPress={() => applyFolderName(folderDraftName)}>
                <Text style={styles.primaryBtnText}>Create + Move</Text>
              </Pressable>
            </View>
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
            <Text style={[styles.muted, themed.muted]}>Final session label: name + date + 4-char random hex.</Text>
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
              <Pressable style={[styles.primaryBtn, themed.accentBg]} onPress={() => void submitHostNameModal()}>
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
    </View>
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
      deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
      deletedAt: parsed.deletedAt && typeof parsed.deletedAt === 'object' ? parsed.deletedAt : {},
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
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
  const combined = [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]
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
      entry.sessionLabel ||
        fallback.sessionLabel ||
        entry.sessionName ||
        fallback.sessionName ||
        ''
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
  setFiles: (updater: (prev: FileRecord[]) => FileRecord[]) => void,
  deleted: Set<string>
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

  if (!item.invite || deleted.has(item.id)) return null

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
        entry.id === item.id ? { ...entry, dataBase64, drivePath: match.drivePath, mimeType: resolvedMime } : entry
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
    fontSize: 36,
    fontWeight: '700',
    color: '#121212'
  },
  topIcons: {
    flexDirection: 'row',
    gap: 12
  },
  topIcon: {
    fontSize: 20
  },
  searchInput: {
    marginHorizontal: 16,
    backgroundColor: '#ececec',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#d8dce3',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#333'
  },
  themeModeRow: {
    marginTop: 8,
    marginHorizontal: 16,
    flexDirection: 'row',
    gap: 8
  },
  themeChip: {
    backgroundColor: '#e9e9e9',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d8dce3',
    paddingVertical: 6,
    paddingHorizontal: 12
  },
  themeChipActive: {
    backgroundColor: '#0f68f5',
    borderColor: '#0f68f5'
  },
  themeChipText: {
    color: '#5e5e5e',
    fontWeight: '600',
    textTransform: 'capitalize'
  },
  themeChipTextActive: {
    color: '#fff'
  },
  scrollContent: {
    paddingBottom: 120,
    gap: 10
  },
  homeCard: {
    backgroundColor: '#fff',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#e7e7e7',
    borderBottomWidth: 1,
    borderBottomColor: '#e7e7e7'
  },
  homeCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  homeCardTitle: {
    fontSize: 29,
    fontWeight: '700',
    color: '#222'
  },
  homeCardText: {
    marginTop: 8,
    color: '#727272',
    fontSize: 19,
    lineHeight: 24,
    maxWidth: '74%'
  },
  homeCardCount: {
    marginTop: 8,
    color: '#3d7df6',
    fontWeight: '600'
  },
  linkText: {
    color: '#3d7df6',
    fontSize: 18,
    fontWeight: '600'
  },
  customizeCard: {
    backgroundColor: '#efefef',
    marginTop: 8,
    marginHorizontal: 0,
    padding: 16,
    gap: 10
  },
  customizeTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#333'
  },
  customizeText: {
    color: '#707070',
    fontSize: 17
  },
  customizeBtn: {
    backgroundColor: '#e4e4e4',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center'
  },
  customizeBtnText: {
    fontWeight: '600',
    color: '#3c3c3c'
  },
  customizePanel: {
    gap: 8
  },
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 10
  },
  customRowText: {
    textTransform: 'capitalize',
    fontWeight: '500'
  },
  customRowActions: {
    flexDirection: 'row',
    gap: 6
  },
  miniControl: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ececec'
  },
  filesTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: '#1a1a1a',
    marginHorizontal: 16,
    marginTop: 8
  },
  inlineActions: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 10
  },
  inviteRow: {
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#d9d9d9',
    borderRadius: 10,
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 8,
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
    borderRadius: 12,
    backgroundColor: '#fff',
    padding: 10,
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
    borderRadius: 12,
    backgroundColor: '#fff',
    padding: 10,
    gap: 4
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
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18
  },
  primaryBtnText: {
    color: '#fff',
    fontWeight: '700'
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#0f68f5',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start'
  },
  secondaryBtnText: {
    color: '#0f68f5',
    fontWeight: '700'
  },
  chipRow: {
    marginTop: 10,
    marginHorizontal: 16
  },
  chip: {
    backgroundColor: '#e9e9e9',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8
  },
  chipActive: {
    backgroundColor: '#0f68f5'
  },
  chipText: {
    color: '#5e5e5e',
    fontWeight: '600',
    textTransform: 'capitalize'
  },
  chipTextActive: {
    color: '#fff'
  },
  filesList: {
    marginTop: 12,
    marginHorizontal: 16,
    gap: 8
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
    borderRadius: 12,
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
    borderRadius: 10,
    padding: 10,
    gap: 4
  },
  folderActionRow: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
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
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10
  },
  fileMeta: {
    flex: 1,
    gap: 4
  },
  checkBtn: {
    marginRight: 2
  },
  checkText: {
    fontSize: 18,
    color: '#454545'
  },
  previewBox: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: '#eef0f3',
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
    color: '#1f1f1f'
  },
  fileSub: {
    color: '#717171',
    fontSize: 12
  },
  fileActions: {
    flexDirection: 'row',
    gap: 6
  },
  rowBtn: {
    backgroundColor: '#efefef',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 9
  },
  rowBtnText: {
    color: '#444',
    fontSize: 12,
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
    fontSize: 12
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
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 70,
    borderTopWidth: 1,
    borderTopColor: '#dedede',
    backgroundColor: '#fff',
    flexDirection: 'row'
  },
  bottomItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bottomText: {
    color: '#7b7b7b',
    fontSize: 15,
    fontWeight: '500'
  },
  bottomTextActive: {
    color: '#111',
    fontWeight: '700'
  },
  folderModalRoot: {
    flex: 1,
    justifyContent: 'center',
    padding: 20
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
