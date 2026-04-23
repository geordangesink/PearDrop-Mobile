const { getMetroConfig } = require('pear-runtime-react-native/metro-config')
const config = getMetroConfig(__dirname)

config.resolver = config.resolver || {}
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  'sodium-native': require.resolve('sodium-javascript')
}

module.exports = config
