const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const bareKitRoot = path.join(root, 'node_modules', 'react-native-bare-kit')

const targets = [
  {
    name: 'android',
    out: path.join(bareKitRoot, 'android', 'src', 'main', 'addons'),
    link: path.join(bareKitRoot, 'android', 'link.mjs')
  },
  {
    name: 'ios',
    out: path.join(bareKitRoot, 'ios', 'addons'),
    link: path.join(bareKitRoot, 'ios', 'link.mjs')
  }
]

for (const target of targets) {
  if (!fs.existsSync(target.link)) {
    console.log(`[bare-kit] ${target.name} link script not found, skipping`)
    continue
  }

  fs.rmSync(target.out, { recursive: true, force: true })
  fs.mkdirSync(target.out, { recursive: true })

  const result = spawnSync(process.execPath, [target.link], {
    cwd: root,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}
