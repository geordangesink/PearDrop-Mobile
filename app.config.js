const appJson = require('./app.json')
const pkg = require('./package.json')

module.exports = ({ config }) => {
  const baseExpoConfig = appJson?.expo || {}
  const incoming = config || {}
  const packageVersion = String(pkg?.version || '').trim()
  const resolvedVersion =
    packageVersion || String(incoming.version || baseExpoConfig.version || '1.0.0').trim()

  return {
    ...baseExpoConfig,
    ...incoming,
    version: resolvedVersion
  }
}
