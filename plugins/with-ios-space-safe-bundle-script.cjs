'use strict'

const fs = require('fs/promises')
const path = require('path')
const { withDangerousMod } = require('expo/config-plugins')

const FROM =
  "`\\\"$NODE_BINARY\\\" --print \\\"require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'\\\"`"
const TO =
  '"$(\\"$NODE_BINARY\\" --print \\\"require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'\\\")"'

module.exports = function withIosSpaceSafeBundleScript(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      if (config.modRequest.introspect) return config

      const iosRoot = config.modRequest.platformProjectRoot
      const entries = await fs.readdir(iosRoot)
      const xcodeprojDir = entries.find((name) => name.endsWith('.xcodeproj'))
      if (!xcodeprojDir) return config

      const pbxprojPath = path.join(iosRoot, xcodeprojDir, 'project.pbxproj')
      const before = await fs.readFile(pbxprojPath, 'utf8')
      if (!before.includes(FROM)) return config

      const after = before.replaceAll(FROM, TO)
      await fs.writeFile(pbxprojPath, after)

      return config
    }
  ])
}
