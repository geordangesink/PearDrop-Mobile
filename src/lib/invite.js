function extractInviteUrl(url) {
  if (!url) return ''
  if (url.startsWith('peardrops://invite')) return url

  try {
    const parsed = new URL(url)
    const invite = parsed.searchParams.get('invite')
    if (invite && invite.startsWith('peardrops://invite')) return invite
  } catch {}

  return ''
}

module.exports = {
  extractInviteUrl
}
