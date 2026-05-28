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
const badgeModulePath = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-notifications',
  'ios',
  'EXNotifications',
  'Badge',
  'BadgeModule.swift'
)
const siphashIndexPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'siphash24',
  'index.js'
)

function patchPodspec(source) {
  let out = source

  out = out.replace(/^\s*env_vars\s*=\s*ENV\['PROJECT_ROOT'\].*$/m, '  env_vars = ""')

  // Execute the script path directly with quotes so workspace paths with spaces work.
  out = out.replace(
    /^\s*:script\s*=>\s*.*get-app-config-ios\.sh.*$/m,
    '    :script => "\\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\\"",'
  )

  return out
}

if (!fs.existsSync(podspecPath)) {
  console.log('[postinstall] EXConstants podspec not found, skipping patch')
} else {
  const before = fs.readFileSync(podspecPath, 'utf8')
  const after = patchPodspec(before)
  if (before === after) {
    console.log('[postinstall] EXConstants podspec already patched')
  } else {
    fs.writeFileSync(podspecPath, after)
    console.log('[postinstall] Patched EXConstants podspec for PROJECT_ROOT paths with spaces')
  }
}

if (!fs.existsSync(badgeModulePath)) {
  console.log('[postinstall] Expo notifications BadgeModule.swift not found, skipping patch')
} else {
  const before = fs.readFileSync(badgeModulePath, 'utf8')
  const after = before.replace(/EXSharedApplication\(\)/g, 'UIApplication.shared')
  if (before === after) {
    console.log('[postinstall] Expo notifications BadgeModule already patched')
  } else {
    fs.writeFileSync(badgeModulePath, after)
    console.log('[postinstall] Patched expo-notifications BadgeModule EXSharedApplication usage')
  }
}

if (!fs.existsSync(siphashIndexPath)) {
  console.log('[postinstall] siphash24 index.js not found, skipping patch')
} else {
  const before = fs.readFileSync(siphashIndexPath, 'utf8')
  let after = before
  after = after.replace(
    "var wasm = typeof WebAssembly !== 'undefined' && require('./siphash24')()",
    'var wasm = false'
  )
  after = after.replace(
    "var wasm = typeof WebAssembly !== 'undefined' && require('./siphash24.js')()",
    'var wasm = false'
  )
  if (before === after) {
    console.log('[postinstall] siphash24 index already patched')
  } else {
    fs.writeFileSync(siphashIndexPath, after)
    console.log('[postinstall] Patched siphash24 to JS fallback mode for Metro compatibility')
  }
}
