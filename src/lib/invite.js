function extractInviteUrl(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  if (text.startsWith('peardrops://invite')) return text
  if (text.startsWith('peardrops:/invite')) {
    return `peardrops://invite${text.slice('peardrops:/invite'.length)}`
  }
  if (text.startsWith('peardrops-web://join')) {
    try {
      const parsed = new URL(text)
      const nested = parsed.searchParams.get('invite')
      if (nested) {
        const normalizedNested = extractInviteUrl(nested)
        if (normalizedNested) return normalizedNested
      }
      if (parsed.search) return `peardrops://invite${parsed.search}`
    } catch {}
    return ''
  }

  try {
    const parsed = new URL(text)
    const nestedInvite = parsed.searchParams.get('invite')
    if (nestedInvite) {
      const normalizedNested = extractInviteUrl(nestedInvite)
      if (normalizedNested) return normalizedNested
    }
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.search) {
      const queryOnly = extractInviteUrl(parsed.search)
      if (queryOnly) return queryOnly
    }
    if (parsed.searchParams.has('drive')) {
      return `peardrops://invite${parsed.search}`
    }
  } catch {}

  if (/^[?&](drive|room|topic|relay|web)=/i.test(text)) {
    return `peardrops://invite${text.startsWith('?') ? text : `?${text.slice(1)}`}`
  }

  return ''
}

function extractShareInviteUrl(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  const directWeb = normalizeWebInvite(text)
  if (directWeb) return directWeb
  return extractInviteUrl(text)
}

function normalizeWebInvite(value) {
  const raw = String(value || '').trim()
  if (!raw.startsWith('peardrops-web://join')) return ''
  try {
    const parsed = new URL(raw)
    const signal = String(parsed.searchParams.get('signal') || '').trim()
    if (!signal) return ''
    return `peardrops-web://join${parsed.search || ''}`
  } catch {
    return ''
  }
}

module.exports = {
  extractInviteUrl,
  extractShareInviteUrl
}
