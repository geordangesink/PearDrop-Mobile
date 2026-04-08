function extractInviteUrl(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  if (text.startsWith('peardrops://invite')) return text
  if (text.startsWith('peardrops-web://join')) {
    try {
      const parsed = new URL(text)
      const nested = parsed.searchParams.get('invite')
      if (nested && nested.startsWith('peardrops://invite')) return nested
      if (parsed.search) return `peardrops://invite${parsed.search}`
    } catch {}
    return ''
  }

  try {
    const parsed = new URL(text)
    const invite = parsed.searchParams.get('invite')
    if (invite && invite.startsWith('peardrops://invite')) return invite
  } catch {}

  return ''
}

module.exports = {
  extractInviteUrl
}
