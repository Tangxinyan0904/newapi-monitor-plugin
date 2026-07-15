import { candidateBaseUrls, endpointUrl, normalizeBaseUrl } from './url.js'

export function normalizeAccount(payload) {
  const value = payload?.data ?? payload
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid account response')
  }
  const rawQuota = value.quota
  const quota = Number(rawQuota)
  if (rawQuota === null || rawQuota === undefined || String(rawQuota).trim() === '' || !Number.isFinite(quota)) {
    throw new Error('Invalid account quota')
  }

  return {
    username: String(value.username ?? ''),
    displayName: String(value.display_name ?? value.displayName ?? value.username ?? ''),
    currentGroup: String(value.group ?? 'default'),
    quota,
    usedQuota: Number(value.used_quota ?? value.usedQuota ?? 0),
    requestCount: Number(value.request_count ?? value.requestCount ?? 0),
  }
}

function normalizedGroup(key, value) {
  const raw = value && typeof value === 'object' ? value : { ratio: value }
  const ratio = Number(raw.ratio ?? raw.group_ratio ?? raw.groupRatio)
  if (!key || !Number.isFinite(ratio)) return null
  return {
    key: String(key),
    label: String(raw.name ?? raw.label ?? key),
    ratio,
    raw,
  }
}

export function normalizeGroups(payload) {
  const value = payload?.data ?? payload
  const groups = Array.isArray(value)
    ? value.map(item => normalizedGroup(item?.key ?? item?.group ?? item?.name, item))
    : Object.entries(value && typeof value === 'object' ? value : {})
        .map(([key, item]) => normalizedGroup(key, item))
  return groups.filter(Boolean)
}

function redact(value, secret) {
  const text = String(value ?? '')
  return secret ? text.split(secret).join('[redacted]') : text
}

function normalizeUsageQuota(payload) {
  const quota = Number(payload?.data?.quota)
  if (!Number.isFinite(quota) || quota < 0) throw new Error('Invalid personal log statistics response')
  return quota
}

function normalizeLogTotal(payload) {
  const total = Number(payload?.data?.total)
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid personal log list response')
  return total
}

function settledPeriod(result) {
  if (result.status === 'fulfilled') return { ok: true, ...result.value }
  return { ok: false, error: String(result.reason?.message || result.reason || 'Request failed') }
}

async function responseMessage(response) {
  try {
    const payload = await response.json()
    return String(payload?.message ?? payload?.error ?? '').slice(0, 240)
  } catch {
    return ''
  }
}

export function createNewApiClient({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  async function requestJson(url, site) {
    const accessToken = String(site.accessToken ?? '').trim()
    const userId = String(site.userId ?? '').trim()
    if (!accessToken) throw new Error('System access token is required')
    if (!userId) throw new Error('New API user ID is required')

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'New-Api-User': userId,
      Accept: 'application/json',
      'User-Agent': 'NewAPI-Monitor/0.1',
    }
    const origin = new URL(url).origin
    let currentUrl = url

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response
      try {
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new Error(redact(error?.message || 'Request failed', accessToken))
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`HTTP ${response.status} redirect without Location`)
        const redirected = new URL(location, currentUrl)
        if (redirected.origin !== origin) {
          throw new Error('Cross-origin redirect rejected before forwarding credentials')
        }
        currentUrl = redirected.toString()
        continue
      }

      const contentType = response.headers.get('content-type') || ''
      if (!response.ok) {
        const detail = redact(await responseMessage(response), accessToken)
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new Error('Upstream response is not JSON')
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('Upstream returned invalid JSON')
      }
      if (payload?.success === false) {
        throw new Error(redact(payload.message || payload.error || 'Upstream request failed', accessToken))
      }
      return payload
    }

    throw new Error('Too many same-origin redirects')
  }

  async function snapshotAt(baseUrl, site) {
    const normalized = normalizeBaseUrl(baseUrl)
    const startedAt = Date.now()
    const accountPayload = await requestJson(endpointUrl(normalized, '/api/user/self'), site)
    const groupPayload = await requestJson(endpointUrl(normalized, '/api/user/self/groups'), site)
    const account = normalizeAccount(accountPayload)
    const groups = normalizeGroups(groupPayload)
    if (!groups.length) throw new Error('No groups found in response')

    return {
      baseUrl: normalized,
      account,
      groups,
      latencyMs: Math.max(0, Date.now() - startedAt),
    }
  }

  async function usageWindowAt(baseUrl, site, startTimestamp, endTimestamp) {
    const query = new URLSearchParams({
      type: '2',
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp),
    })
    const [statPayload, logsPayload] = await Promise.all([
      requestJson(`${endpointUrl(baseUrl, '/api/log/self/stat')}?${query}`, site),
      requestJson(`${endpointUrl(baseUrl, '/api/log/self')}?${query}`, site),
    ])
    return {
      requestCount: normalizeLogTotal(logsPayload),
      usedQuota: normalizeUsageQuota(statPayload),
    }
  }

  async function fetchSnapshot(site) {
    return snapshotAt(normalizeBaseUrl(site.baseUrl), site)
  }

  async function testConnection(site) {
    const errors = []
    for (const baseUrl of candidateBaseUrls(site.baseUrl)) {
      try {
        return await snapshotAt(baseUrl, site)
      } catch (error) {
        errors.push(`${baseUrl}: ${redact(error?.message, site.accessToken)}`)
      }
    }
    throw new Error(`Connection test failed: ${errors.join('; ')}`)
  }

  async function fetchDashboardSite(site, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
    const baseUrl = normalizeBaseUrl(site.baseUrl)
    const startedAt = Date.now()
    const results = await Promise.allSettled([
      requestJson(endpointUrl(baseUrl, '/api/user/self'), site).then(normalizeAccount),
      usageWindowAt(baseUrl, site, nowSeconds - 3600, nowSeconds),
      usageWindowAt(baseUrl, site, nowSeconds - 24 * 3600, nowSeconds),
    ])
    const account = results[0].status === 'fulfilled' ? results[0].value : null
    const accountError = results[0].status === 'rejected'
      ? String(results[0].reason?.message || results[0].reason || 'Request failed')
      : ''

    return {
      baseUrl,
      account,
      accountError,
      periods: {
        oneHour: settledPeriod(results[1]),
        twentyFourHours: settledPeriod(results[2]),
      },
      latencyMs: Math.max(0, Date.now() - startedAt),
    }
  }

  return { fetchSnapshot, testConnection, fetchDashboardSite }
}
