const KNOWN_SUFFIX = /\/(?:api|v1|log|logs|dashboard|console|profile)(?:\/.*)?$/i

function parseHttpUrl(input) {
  let value = String(input ?? '').trim()
  if (!value) throw new Error('Site URL is required')
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`

  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are allowed')
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed')

  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url
}

export function normalizeBaseUrl(input) {
  const url = parseHttpUrl(input)
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(KNOWN_SUFFIX, '')
  return `${url.origin}${pathname}`.replace(/\/+$/, '')
}

export function candidateBaseUrls(input) {
  const url = parseHttpUrl(input)
  return [...new Set([normalizeBaseUrl(url.toString()), url.origin])]
}

export function endpointUrl(baseUrl, pathname) {
  return `${normalizeBaseUrl(baseUrl)}/${String(pathname).replace(/^\/+/, '')}`
}
