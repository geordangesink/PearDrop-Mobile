const fs = require('fs')
const path = require('path')

const podspecPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo',
  'node_modules',
  'expo-constants',
  'ios',
  'EXConstants.podspec'
)

function patchPodspec(source) {
  let out = source

  out = out.replace(/^\s*env_vars = .*$/m, '  env_vars = ""')

  out = out.replace(
    /^\s*:script => .*get-app-config-ios\.sh.*$/m,
    '    :script => "bash -l -c \\"\\\\\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\\\\\"\\"",'
  )

  return out
}

if (!fs.existsSync(podspecPath)) {
  console.log('[postinstall] EXConstants podspec not found, skipping patch')
  process.exit(0)
}

const before = fs.readFileSync(podspecPath, 'utf8')
const after = patchPodspec(before)

if (before === after) {
  console.log('[postinstall] EXConstants podspec already patched')
  process.exit(0)
}

fs.writeFileSync(podspecPath, after)
console.log('[postinstall] Patched EXConstants podspec for PROJECT_ROOT paths with spaces')
