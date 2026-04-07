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
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system'
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
  START_HOST_FROM_TRANSFER: 9
} as const

type Tab = 'home' | 'files' | 'photos'
type FilesFilter = 'all' | 'recent' | 'starred' | 'host' | 'deleted'
type HomeSection = 'recent' | 'starred' | 'host'

type FileRecord = {
  id: string
  name: string
  byteLength: number
  updatedAt: number
  source: 'upload' | 'download' | 'local'
  invite: string
  path?: string
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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const METADATA_PATH = `${FileSystem.documentDirectory || ''}peardrops-mobile-metadata.json`

type PersistedMetadata = {
  files: FileRecord[]
  starred: string[]
  deleted: string[]
  deletedAt: Record<string, number>
  folders: FolderRecord[]
}

const updaterConfig = {
  dev: __DEV__,
  version: '0.1.0',
  upgrade: 'pear://updates-disabled',
  relayUrl: '',
  updates: !__DEV__
}

export default function App() {
  const [status, setStatus] = useState('Starting worker...')
  const [activeTab, setActiveTab] = useState<Tab>('home')
  const [filesFilter, setFilesFilter] = useState<FilesFilter>('all')
  const [search, setSearch] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [latestInvite, setLatestInvite] = useState('')
  const [history, setHistory] = useState<any[]>([])
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
  const [pendingHostMode, setPendingHostMode] = useState<'selected' | 'history' | ''>('')
  const [pendingHostTransferId, setPendingHostTransferId] = useState('')
  const previewTranslateY = useRef(new Animated.Value(0)).current
  const [fabOpen, setFabOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [homeSections, setHomeSections] = useState<HomeSection[]>(['recent', 'starred', 'host'])
  const [hiddenSections, setHiddenSections] = useState<Set<HomeSection>>(new Set())

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
        try {
          const hosts = await rpc.request(RpcCommand.LIST_ACTIVE_HOSTS)
          setActiveHosts(hosts.hosts || [])
        } catch {}
        if (initial.updaterError) {
          setStatus(`Ready (${initial.version}) - updater warning: ${initial.updaterError}`)
        } else {
          setStatus(`Ready (${initial.version})`)
        }
      } catch (error: any) {
        setStatus(`Init failed: ${error?.message || String(error)}`)
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
      folders
    }
    void savePersistedMetadata(payload)
  }, [files, starred, deleted, deletedAt, folders, metadataLoaded])

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
      setInviteInput(invite)
      setActiveTab('files')
      setStatus('Invite captured from deep link')
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
  }

  const refreshHosts = async () => {
    const result = await rpc.request(RpcCommand.LIST_ACTIVE_HOSTS)
    setActiveHosts(result.hosts || [])
  }

  const onUpload = async () => {
    try {
      const pick = await DocumentPicker.getDocumentAsync({ multiple: true })
      if (pick.canceled || pick.assets.length === 0) return

      setStatus('Preparing files...')
      const payloadFiles = []
      for (const asset of pick.assets) {
        const dataBase64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64
        })
        payloadFiles.push({
          id: `local:${Date.now()}:${asset.name}`,
          name: asset.name,
          byteLength: Number(asset.size || 0),
          updatedAt: Date.now(),
          source: 'local',
          invite: '',
          mimeType: asset.mimeType || 'application/octet-stream',
          dataBase64
        })
      }
      setFiles((prev) => [...payloadFiles, ...prev])
      setStatus(`Added ${payloadFiles.length} file(s). Select and tap Host Upload.`)
      setFabOpen(false)
    } catch (error: any) {
      Alert.alert('Upload failed', error?.message || String(error))
    }
  }

  const onHostSelected = async (sessionNameRaw: string) => {
    const sessionName = String(sessionNameRaw || '').trim() || 'Host Session'
    const picked = files.filter((item) => selected.has(item.id) && !deleted.has(item.id))
    if (!picked.length) {
      Alert.alert('Select files', 'Select one or more files first.')
      return
    }

    const payload = picked
      .map((item) =>
        item.dataBase64
          ? {
              name: item.name,
              mimeType: item.mimeType || 'application/octet-stream',
              dataBase64: item.dataBase64
            }
          : null
      )
      .filter(Boolean)

    if (!payload.length) {
      Alert.alert('Not hostable', 'Selected files are not available locally for hosting.')
      return
    }

    try {
      setStatus('Hosting selected files...')
      const result = await rpc.request(RpcCommand.CREATE_UPLOAD, { files: payload, sessionName })
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
      setStatus(`Hosting ${payload.length} file(s)`)
      await Promise.all([refresh(), refreshHosts()])
    } catch (error: any) {
      Alert.alert('Host failed', error?.message || String(error))
    }
  }

  const startHostNamePromptForSelected = () => {
    setPendingHostMode('selected')
    setPendingHostTransferId('')
    setHostNameDraft('Host Session')
    setHostNameModalVisible(true)
  }

  const startHostFromHistoryPrompt = (transferId: string, defaultName = 'Host Session') => {
    setPendingHostMode('history')
    setPendingHostTransferId(transferId)
    setHostNameDraft(defaultName)
    setHostNameModalVisible(true)
  }

  const submitHostNameModal = async () => {
    const sessionName = String(hostNameDraft || '').trim() || 'Host Session'
    setHostNameModalVisible(false)
    try {
      if (pendingHostMode === 'selected') {
        await onHostSelected(sessionName)
        return
      }
      if (pendingHostMode === 'history' && pendingHostTransferId) {
        setStatus('Starting host from history...')
        const result = await rpc.request(RpcCommand.START_HOST_FROM_TRANSFER, {
          transferId: pendingHostTransferId,
          sessionName
        })
        const invite = result.nativeInvite || result.invite || ''
        if (invite) {
          setLatestInvite(invite)
          setStatus('Hosting started from history')
        }
        await Promise.all([refresh(), refreshHosts()])
      }
    } catch (error: any) {
      Alert.alert('Host failed', error?.message || String(error))
    } finally {
      setPendingHostMode('')
      setPendingHostTransferId('')
    }
  }

  const dismissHostNameModal = () => {
    setHostNameModalVisible(false)
    setPendingHostMode('')
    setPendingHostTransferId('')
  }

  const onDownload = async () => {
    const invite = inviteInput.trim()
    if (!invite) {
      Alert.alert('Invite required', 'Paste a peardrops://invite URL first.')
      return
    }

    try {
      setStatus('Joining transfer...')
      const result = await rpc.request(RpcCommand.DOWNLOAD, { invite })

      const now = Date.now()
      setFiles((prev) => {
        const next = prev.slice()
        for (const entry of result.files || []) {
          next.unshift({
            id: `download:${now}:${entry.path || entry.name}`,
            name: entry.name,
            byteLength: Number(entry.byteLength || 0),
            updatedAt: now,
            source: 'download',
            invite
          })
        }
        return next
      })

      setStatus(`Downloaded ${result.files.length} file(s)`)
      setFabOpen(false)
      await refresh()
    } catch (error: any) {
      Alert.alert('Download failed', error?.message || String(error))
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

  const openSection = (section: HomeSection) => {
    setActiveTab('files')
    setFilesFilter(section)
    setHostDetailInvite('')
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
      <View key={section} style={styles.homeCard}>
        <View style={styles.homeCardHead}>
          <Text style={styles.homeCardTitle}>{map.title}</Text>
          <Pressable onPress={() => openSection(section)}>
            <Text style={styles.linkText}>See all</Text>
          </Pressable>
        </View>
        <Text style={styles.homeCardText}>{map.text}</Text>
        <Text style={styles.homeCardCount}>{sectionCounts[section]} items</Text>
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

  const renderHostContent = () => {
    if (hostDetailInvite) {
      const host = activeHosts.find((item) => item.invite === hostDetailInvite)
      if (!host) {
        return <Text style={styles.muted}>Host session is no longer active.</Text>
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

    const hostHistory = history
      .filter((item) => item.type === 'upload')
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 15)

    return (
      <View style={styles.hostSection}>
        <Text style={styles.hostSectionTitle}>Active hosts (online)</Text>
        {activeHosts.length === 0 ? (
          <Text style={styles.muted}>No active host sessions.</Text>
        ) : (
          activeHosts.map((host) => (
            <View key={host.invite} style={styles.hostCard}>
              <Pressable onPress={() => setHostDetailInvite(host.invite)}>
                <Text style={styles.hostCardTitle}>{host.sessionLabel || host.invite}</Text>
              </Pressable>
              <Text style={styles.fileSub}>
                {host.fileCount || 0} files • {formatBytes(Number(host.totalBytes || 0))}
              </Text>
              <View style={styles.hostCardActions}>
                <Pressable style={styles.rowBtn} onPress={() => setHostDetailInvite(host.invite)}>
                  <Text style={styles.rowBtnText}>Open</Text>
                </Pressable>
                <Pressable
                  style={styles.rowBtn}
                  onPress={() => {
                    setInviteInput(host.invite)
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

        <Text style={styles.hostSectionTitle}>History</Text>
        {hostHistory.length === 0 ? (
          <Text style={styles.muted}>No host history yet.</Text>
        ) : (
          hostHistory.map((item) => {
            const preview = Array.isArray(item.manifest)
              ? item.manifest
                  .slice(0, 2)
                  .map((entry: any) => entry.name)
                  .join(', ')
              : 'No manifest preview'
            return (
              <View key={item.id} style={styles.hostCard}>
                <Text style={styles.hostCardTitle}>
                  {item.sessionLabel || item.sessionName || item.invite || 'Upload history'}
                </Text>
                <Text style={styles.fileSub}>{preview || 'No manifest preview'}</Text>
                <View style={styles.hostCardActions}>
                  <Pressable
                    style={styles.rowBtn}
                    onPress={() =>
                      startHostFromHistoryPrompt(
                        item.id,
                        item.sessionName || item.sessionLabel || 'Host Session'
                      )
                    }
                  >
                    <Text style={styles.rowBtnText}>Start hosting</Text>
                  </Pressable>
                  {item.invite ? (
                    <Pressable
                      style={styles.rowBtn}
                      onPress={() => {
                        setInviteInput(item.invite)
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

  const renderFileList = () => {
    if (!visibleFiles.length) {
      return <Text style={styles.muted}>No files in this section yet.</Text>
    }

    return visibleFiles.map((item) => {
      const isStarred = starred.has(item.id)
      const isSelected = selected.has(item.id)
      const isImage = String(item.mimeType || '').startsWith('image/') && item.dataBase64
      const isVideo = String(item.mimeType || '').startsWith('video/')
      const folderName = folders.find((folder) => folder.id === item.folderId)?.name || ''
      const isDeleted = deleted.has(item.id)
      return (
        <View key={item.id} style={styles.fileRow}>
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
            <Text style={styles.fileName}>{item.name}</Text>
            <Text style={styles.fileSub}>
              {formatBytes(item.byteLength)} • {formatDate(item.updatedAt)} • {item.source}
            </Text>
            {folderName ? <Text style={styles.fileSub}>Folder: {folderName}</Text> : null}
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
    <View style={styles.container}>
      <StatusBar style='dark' />

      <View style={styles.topHeader}>
        <Text style={styles.topTitle}>Home</Text>
        <View style={styles.topIcons}>
          <Text style={styles.topIcon}>🔔</Text>
          <Text style={styles.topIcon}>⇪</Text>
        </View>
      </View>

      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder='Search for anything'
        style={styles.searchInput}
      />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {activeTab === 'home' ? (
          <>
            {homeSections.map((section) => renderHomeSectionCard(section))}

            <View style={styles.customizeCard}>
              <Text style={styles.customizeTitle}>Customize your home screen</Text>
              <Text style={styles.customizeText}>
                Add, remove, or reorder sections to show what matters most.
              </Text>
              <Pressable style={styles.customizeBtn} onPress={() => setCustomizeOpen((v) => !v)}>
                <Text style={styles.customizeBtnText}>
                  {customizeOpen ? 'Done customizing' : 'Customize'}
                </Text>
              </Pressable>

              {customizeOpen ? (
                <View style={styles.customizePanel}>
                  {homeSections.map((section) => (
                    <View key={`custom-${section}`} style={styles.customRow}>
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
            <Text style={styles.filesTitle}>
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
              <Pressable style={styles.primaryBtn} onPress={onUpload}>
                <Text style={styles.primaryBtnText}>Add Files</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={startHostNamePromptForSelected}>
                <Text style={styles.primaryBtnText}>Host Upload</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={onDownload}>
                <Text style={styles.secondaryBtnText}>Download</Text>
              </Pressable>
            </View>

            {selected.size && filesFilter !== 'host' ? (
              <View style={styles.bulkBar}>
                <Text style={styles.bulkText}>{selected.size} selected</Text>
                <Pressable style={styles.rowBtn} onPress={startHostNamePromptForSelected}>
                  <Text style={styles.rowBtnText}>🔗</Text>
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

            {folderFilter ? (
              <View style={styles.folderActionRow}>
                <Text style={styles.folderActionText}>
                  Folder: {folders.find((item) => item.id === folderFilter)?.name || ''}
                </Text>
                <Pressable style={styles.rowBtn} onPress={deleteCurrentFolder}>
                  <Text style={[styles.rowBtnText, styles.rowDeleteText]}>Delete folder</Text>
                </Pressable>
              </View>
            ) : null}

            <TextInput
              value={inviteInput}
              onChangeText={setInviteInput}
              placeholder='Paste peardrops://invite link'
              style={styles.inviteInput}
              multiline
            />

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {(['all', 'recent', 'starred', 'host', 'deleted'] as FilesFilter[]).map((filter) => (
                <Pressable
                  key={filter}
                  style={[styles.chip, filesFilter === filter && styles.chipActive]}
                  onPress={() => {
                    setFilesFilter(filter)
                    if (filter !== 'host') setHostDetailInvite('')
                    if (filter === 'recent') setRecentVisible(10)
                    if (filter === 'deleted') setDeletedVisible(10)
                    if (filter === 'host') void refreshHosts()
                  }}
                >
                  <Text style={[styles.chipText, filesFilter === filter && styles.chipTextActive]}>
                    {filter}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              <Pressable
                style={[styles.chip, folderFilter === '' && styles.chipActive]}
                onPress={() => setFolderFilter('')}
              >
                <Text style={[styles.chipText, folderFilter === '' && styles.chipTextActive]}>
                  All folders
                </Text>
              </Pressable>
              {folders.map((folder) => (
                <Pressable
                  key={folder.id}
                  style={[styles.chip, folderFilter === folder.id && styles.chipActive]}
                  onPress={() => setFolderFilter(folder.id)}
                >
                  <Text
                    style={[styles.chipText, folderFilter === folder.id && styles.chipTextActive]}
                  >
                    {folder.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.filesList}>
              {filesFilter === 'host' ? renderHostContent() : renderFileList()}
            </View>

            {((filesFilter === 'recent' && canLoadMoreRecent) ||
              (filesFilter === 'deleted' && canLoadMoreDeleted)) && (
              <Pressable
                style={styles.secondaryBtn}
                onPress={() => {
                  if (filesFilter === 'recent') setRecentVisible((v) => v + 10)
                  else setDeletedVisible((v) => v + 10)
                }}
              >
                <Text style={styles.secondaryBtnText}>Load more</Text>
              </Pressable>
            )}
          </>
        ) : null}

        {activeTab === 'photos' ? (
          <View style={styles.placeholderCard}>
            <Text style={styles.placeholderTitle}>Photos</Text>
            <Text style={styles.muted}>
              Photo-specific organization is next. Files still remain available in Files.
            </Text>
          </View>
        ) : null}

        <Text style={styles.status}>{status}</Text>
      </ScrollView>

      {fabOpen ? (
        <View style={styles.fabMenu}>
          <Pressable style={styles.fabItem} onPress={onUpload}>
            <Text style={styles.fabItemText}>Upload files</Text>
          </Pressable>
          <Pressable style={styles.fabItem} onPress={onDownload}>
            <Text style={styles.fabItemText}>Download from invite</Text>
          </Pressable>
          <Pressable style={styles.fabItem} onPress={onShareInvite}>
            <Text style={styles.fabItemText}>Share latest invite</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable style={styles.fab} onPress={() => setFabOpen((v) => !v)}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      <View style={styles.bottomBar}>
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
              <Text style={[styles.bottomText, active && styles.bottomTextActive]}>
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
          <View style={styles.folderModalCard}>
            <Text style={styles.folderModalTitle}>Put In Folder</Text>
            <Text style={styles.muted}>Select an existing folder or create a new one.</Text>
            <ScrollView style={styles.folderOptionsScroll}>
              {folders.length ? (
                folders.map((folder) => (
                  <Pressable
                    key={folder.id}
                    style={styles.folderOptionBtn}
                    onPress={() => applyFolderName(folder.name)}
                  >
                    <Text style={styles.folderOptionText}>{folder.name}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.muted}>No folders yet.</Text>
              )}
            </ScrollView>
            <TextInput
              value={folderDraftName}
              onChangeText={setFolderDraftName}
              placeholder='New folder name'
              style={styles.folderInput}
            />
            <View style={styles.folderModalActions}>
              <Pressable style={styles.rowBtn} onPress={() => setFolderModalVisible(false)}>
                <Text style={styles.rowBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={() => applyFolderName(folderDraftName)}>
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
          <View style={styles.folderModalCard}>
            <Text style={styles.folderModalTitle}>Host session name</Text>
            <Text style={styles.muted}>Final session label: name + date + 4-char random hex.</Text>
            <TextInput
              value={hostNameDraft}
              onChangeText={setHostNameDraft}
              placeholder='Host Session'
              style={styles.folderInput}
            />
            <View style={styles.folderModalActions}>
              <Pressable style={styles.rowBtn} onPress={dismissHostNameModal}>
                <Text style={styles.rowBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={() => void submitHostNameModal()}>
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
      folders: Array.isArray(parsed.folders) ? parsed.folders : []
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
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#333'
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
  inviteInput: {
    marginHorizontal: 16,
    marginTop: 10,
    minHeight: 70,
    borderWidth: 1,
    borderColor: '#d9d9d9',
    borderRadius: 12,
    padding: 10,
    textAlignVertical: 'top',
    backgroundColor: '#fff'
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
    marginHorizontal: 16,
    marginTop: 10,
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
