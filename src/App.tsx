/* global __DEV__ */

import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
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
  READ_ENTRY: 6
} as const

type Tab = 'home' | 'files' | 'photos' | 'account'
type FilesFilter = 'all' | 'recent' | 'starred' | 'shared' | 'offline' | 'deleted'
type HomeSection = 'recent' | 'starred' | 'shared' | 'offline'

type FileRecord = {
  id: string
  name: string
  byteLength: number
  updatedAt: number
  source: 'upload' | 'download'
  invite: string
  deleted?: boolean
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
  const [latestWebLink, setLatestWebLink] = useState('')
  const [history, setHistory] = useState<any[]>([])
  const [files, setFiles] = useState<FileRecord[]>([])
  const [starred, setStarred] = useState<Set<string>>(new Set())
  const [fabOpen, setFabOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [homeSections, setHomeSections] = useState<HomeSection[]>([
    'recent',
    'starred',
    'shared',
    'offline'
  ])
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

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase()

    const filtered = files.filter((item) => {
      const deleted = Boolean(item.deleted)
      if (filesFilter === 'deleted') return deleted
      if (deleted) return false

      if (filesFilter === 'recent') return true
      if (filesFilter === 'starred') return starred.has(item.id)
      if (filesFilter === 'shared') return item.source === 'upload'
      if (filesFilter === 'offline') return item.source === 'download'
      return true
    })

    const sorted = filtered
      .slice()
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, filesFilter === 'recent' ? 20 : 200)

    if (!q) return sorted
    return sorted.filter((item) => item.name.toLowerCase().includes(q))
  }, [files, filesFilter, search, starred])

  const sectionCounts = useMemo(() => {
    const active = files.filter((item) => !item.deleted)
    return {
      recent: active.length,
      starred: active.filter((item) => starred.has(item.id)).length,
      shared: active.filter((item) => item.source === 'upload').length,
      offline: active.filter((item) => item.source === 'download').length
    }
  }, [files, starred])

  const refresh = async () => {
    const result = await rpc.request(RpcCommand.LIST_TRANSFERS)
    setHistory(result.transfers || [])
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
          name: asset.name,
          mimeType: asset.mimeType || 'application/octet-stream',
          dataBase64
        })
      }

      const result = await rpc.request(RpcCommand.CREATE_UPLOAD, { files: payloadFiles })
      setLatestInvite(result.nativeInvite || result.invite)
      setLatestWebLink(result.webSwarmLink || '')

      const now = Date.now()
      setFiles((prev) => {
        const next = prev.slice()
        for (const entry of result.manifest || []) {
          next.unshift({
            id: `upload:${now}:${entry.drivePath}`,
            name: entry.name,
            byteLength: Number(entry.byteLength || 0),
            updatedAt: now,
            source: 'upload',
            invite: result.nativeInvite || result.invite,
            deleted: false
          })
        }
        return next
      })

      setStatus(`Hosting ${result.manifest.length} file(s)`)
      setFabOpen(false)
      await refresh()
    } catch (error: any) {
      Alert.alert('Upload failed', error?.message || String(error))
    }
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
            invite,
            deleted: false
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

    const message = latestWebLink
      ? `Native invite:\n${latestInvite}\n\nWeb link:\n${latestWebLink}`
      : latestInvite

    await Share.share({
      message,
      url: latestInvite,
      title: 'Pear Drops invite'
    })
  }

  const openSection = (section: HomeSection) => {
    setActiveTab('files')
    setFilesFilter(section)
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
    setFiles((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              deleted: !item.deleted
            }
          : item
      )
    )
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
      shared: {
        title: 'Shared',
        text: 'Your shared folders show up here so they are easy to find.'
      },
      offline: {
        title: 'Offline',
        text: 'Make your most important files available without internet.'
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

  const renderFileList = () => {
    if (visibleFiles.length === 0) {
      return <Text style={styles.muted}>No files in this section yet.</Text>
    }

    return visibleFiles.map((item) => {
      const isStarred = starred.has(item.id)
      return (
        <View key={item.id} style={styles.fileRow}>
          <View style={styles.fileMeta}>
            <Text style={styles.fileName}>{item.name}</Text>
            <Text style={styles.fileSub}>
              {formatBytes(item.byteLength)} • {formatDate(item.updatedAt)} •{' '}
              {item.source === 'upload' ? 'Shared' : 'Offline'}
            </Text>
          </View>
          <View style={styles.fileActions}>
            <Pressable onPress={() => toggleStar(item.id)} style={styles.rowBtn}>
              <Text style={styles.rowBtnText}>{isStarred ? 'Unstar' : 'Star'}</Text>
            </Pressable>
            <Pressable onPress={() => toggleDelete(item.id)} style={styles.rowBtn}>
              <Text style={styles.rowBtnText}>{item.deleted ? 'Restore' : 'Delete'}</Text>
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
              <Text style={styles.customizeText}>Add, remove, or reorder sections to show what matters most.</Text>
              <Pressable style={styles.customizeBtn} onPress={() => setCustomizeOpen((v) => !v)}>
                <Text style={styles.customizeBtnText}>{customizeOpen ? 'Done customizing' : 'Customize'}</Text>
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
                        <Pressable onPress={() => moveSection(section, -1)} style={styles.miniControl}>
                          <Text>↑</Text>
                        </Pressable>
                        <Pressable onPress={() => moveSection(section, 1)} style={styles.miniControl}>
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
            <Text style={styles.filesTitle}>All files</Text>

            <View style={styles.inlineActions}>
              <Pressable style={styles.primaryBtn} onPress={onUpload}>
                <Text style={styles.primaryBtnText}>Upload</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={onDownload}>
                <Text style={styles.secondaryBtnText}>Download</Text>
              </Pressable>
            </View>

            <TextInput
              value={inviteInput}
              onChangeText={setInviteInput}
              placeholder='Paste peardrops://invite link'
              style={styles.inviteInput}
              multiline
            />

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {(['all', 'recent', 'starred', 'shared', 'offline', 'deleted'] as FilesFilter[]).map((filter) => (
                <Pressable
                  key={filter}
                  style={[styles.chip, filesFilter === filter && styles.chipActive]}
                  onPress={() => setFilesFilter(filter)}
                >
                  <Text style={[styles.chipText, filesFilter === filter && styles.chipTextActive]}>{filter}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.filesList}>{renderFileList()}</View>
          </>
        ) : null}

        {activeTab === 'photos' ? (
          <View style={styles.placeholderCard}>
            <Text style={styles.placeholderTitle}>Photos</Text>
            <Text style={styles.muted}>Photo-specific organization is next. Files still remain available in Files.</Text>
          </View>
        ) : null}

        {activeTab === 'account' ? (
          <View style={styles.placeholderCard}>
            <Text style={styles.placeholderTitle}>Account</Text>
            <Text style={styles.muted}>Transfers: {history.length}</Text>
            <Text style={styles.muted}>Latest invite:</Text>
            <Text style={styles.codeText}>{latestInvite || 'No invite yet'}</Text>
            <Pressable style={styles.secondaryBtn} onPress={onShareInvite}>
              <Text style={styles.secondaryBtnText}>Share latest invite</Text>
            </Pressable>
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
          { key: 'photos', label: 'Photos' },
          { key: 'account', label: 'Account' }
        ].map((item) => {
          const active = activeTab === item.key
          return (
            <Pressable key={item.key} style={styles.bottomItem} onPress={() => setActiveTab(item.key as Tab)}>
              <Text style={[styles.bottomText, active && styles.bottomTextActive]}>{item.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
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

async function requestInitWithRetry(rpc: { request: (command: number, payload?: any) => Promise<any> }, attempts: number) {
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
  }
})
