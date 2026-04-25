/* global Bare */
const path = require('bare-path')
const os = require('bare-os')
const dir = require('bare-storage')
const b4a = require('b4a')
const PearSuspension = require('pear-suspension')
const { bootstrapTransferWorker } = require('pear-drop-core')
const FALLBACK_RELAY_URL = 'wss://pear-drops.up.railway.app'

function resolveUpdaterConfig(argv = []) {
  const values = Array.isArray(argv) ? argv : []
  for (let i = values.length - 1; i >= 0; i--) {
    const raw = String(values[i] || '').trim()
    if (!raw || raw[0] !== '{') continue
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
  }
  return {}
}

async function main() {
  const updaterConfig = resolveUpdaterConfig(Bare.argv)
  if (!updaterConfig.relayUrl) updaterConfig.relayUrl = FALLBACK_RELAY_URL
  const persistentDir = updaterConfig.dir || dir.persistent()
  const baseRoot = updaterConfig.dev ? os.tmpdir() : persistentDir

  const worker = await bootstrapTransferWorker({
    ipc: Bare.IPC,
    baseDir: path.join(baseRoot, 'pear-drops-mobile'),
    metadataDir: path.join(persistentDir, 'pear-drops-mobile-history'),
    updaterConfig,
    relayUrl: updaterConfig.relayUrl || ''
  })

  // Keep worker resources healthy across app background/foreground transitions.
  // Parent worklet calls suspend/resume; this child handles runtime lifecycle hooks.
  new PearSuspension({
    store: worker?.backend?.store,
    swarm: worker?.backend?.swarm,
    async suspend() {},
    async resume() {}
  })
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  Bare.IPC.write(b4a.from(JSON.stringify({ type: 'fatal', message }), 'utf8'))
  throw error
})
