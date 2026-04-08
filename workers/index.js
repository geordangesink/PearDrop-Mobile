/* global Bare */
const path = require('bare-path')
const os = require('bare-os')
const dir = require('bare-storage')
const b4a = require('b4a')
const { bootstrapTransferWorker } = require('pear-drop-core')

async function main() {
  const updaterConfig = JSON.parse(Bare.argv[2] || '{}')
  const persistentDir = updaterConfig.dir || dir.persistent()
  const baseRoot = updaterConfig.dev ? os.tmpdir() : persistentDir

  await bootstrapTransferWorker({
    ipc: Bare.IPC,
    baseDir: path.join(baseRoot, 'pear-drops-mobile'),
    metadataDir: path.join(persistentDir, 'pear-drops-mobile-history'),
    updaterConfig,
    relayUrl: updaterConfig.relayUrl || ''
  })
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  Bare.IPC.write(b4a.from(JSON.stringify({ type: 'fatal', message }), 'utf8'))
  throw error
})
