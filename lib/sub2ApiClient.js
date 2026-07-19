import { candidateBaseUrls, endpointUrl, normalizeBaseUrl } from './url.js'

export const SUB2_CURRENT_GROUP_KEY = '__sub2api_current_key__'

function redact(value, secret) {
  const text = String(value ?? '')
  return secret ? text.split(secret).join('[redacted]') : text
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function usageValue(payload) {
  const value = payload?.data ?? payload
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Sub2API usage response')
  }
  return value
}

function normalizeUsage(payload) {
  const value = usageValue(payload)
  const rawBalance = value.balance
    ?? value.remaining
    ?? (value.quota && typeof value.quota === 'object' ? value.quota.remaining : value.quota)
  const balance = numberOrNull(rawBalance)
  if (balance === null) throw new Error('Invalid Sub2API balance')

  const usage = value.usage && typeof value.usage === 'object' ? value.usage : {}
  const today = usage.today && typeof usage.today === 'object' ? usage.today : {}
  const total = usage.total && typeof usage.total === 'object' ? usage.total : {}
  return {
    balance,
    account: {
      username: String(value.username ?? value.user?.username ?? ''),
      displayName: String(value.display_name ?? value.displayName ?? value.planName ?? ''),
      currentGroup: '当前 API Key',
      quota: balance,
      usedQuota: numberOrNull(total.actual_cost) ?? 0,
      requestCount: numberOrNull(total.requests) ?? 0,
      unit: String(value.unit ?? 'USD'),
      usage: {
        today: {
          requestCount: numberOrNull(today.requests) ?? 0,
          usedQuota: numberOrNull(today.actual_cost) ?? 0,
        },
        total: {
          requestCount: numberOrNull(total.requests) ?? 0,
          usedQuota: numberOrNull(total.actual_cost) ?? 0,
        },
      },
    },
  }
}

function normalizeBilling(payload) {
  const value = payload?.data ?? payload
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Sub2API billing response')
  }
  const ratio = numberOrNull(
    value.effective_rate_multiplier
      ?? value.resolved_rate_multiplier
      ?? value.group_rate_multiplier,
  )
  if (ratio === null) throw new Error('Invalid Sub2API rate multiplier')
  return {
    key: SUB2_CURRENT_GROUP_KEY,
    label: '当前 API Key',
    ratio,
  }
}

function responseMessage(response) {
  return response.json()
    .then(payload => String(payload?.message ?? payload?.error ?? '').slice(0, 240))
    .catch(() => '')
}

export function createSub2ApiClient({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  async function requestJson(url, site) {
    const accessToken = String(site.accessToken ?? '').trim()
    if (!accessToken) throw new Error('Sub2API API Key is required')
    const origin = new URL(url).origin
    let currentUrl = url

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response
      try {
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          headers: {
            'x-api-key': accessToken,
            Accept: 'application/json',
            'User-Agent': 'NewAPI-Monitor/0.1',
          },
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
        if (redirected.origin !== origin) throw new Error('Cross-origin redirect rejected before forwarding credentials')
        currentUrl = redirected.toString()
        continue
      }

      if (!response.ok) {
        const detail = redact(await responseMessage(response), accessToken)
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('application/json')) throw new Error('Upstream response is not JSON')
      try {
        const payload = await response.json()
        if (payload?.success === false) throw new Error(payload.message || payload.error || 'Upstream request failed')
        return payload
      } catch (error) {
        if (error?.message === 'Upstream request failed' || error?.message?.startsWith('Upstream')) {
          throw new Error(redact(error.message, accessToken))
        }
        throw new Error('Upstream returned invalid JSON')
      }
    }
    throw new Error('Too many same-origin redirects')
  }

  async function snapshotAt(baseUrl, site) {
    const normalized = normalizeBaseUrl(baseUrl)
    const startedAt = Date.now()
    const [usagePayload, billingPayload] = await Promise.all([
      requestJson(endpointUrl(normalized, '/v1/usage'), site),
      requestJson(endpointUrl(normalized, '/v1/sub2api/billing'), site),
    ])
    const usage = normalizeUsage(usagePayload)
    return {
      baseUrl: normalized,
      balance: usage.balance,
      account: usage.account,
      groups: [normalizeBilling(billingPayload)],
      latencyMs: Math.max(0, Date.now() - startedAt),
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

  async function fetchDashboardSite(site) {
    const baseUrl = normalizeBaseUrl(site.baseUrl)
    const startedAt = Date.now()
    try {
      const usage = normalizeUsage(await requestJson(endpointUrl(baseUrl, '/v1/usage'), site))
      const unavailable = 'Sub2API API Key 接口未提供近 1 小时/24 小时日志统计'
      return {
        baseUrl,
        balance: usage.balance,
        account: usage.account,
        accountError: '',
        periods: {
          oneHour: { ok: false, error: unavailable },
          twentyFourHours: { ok: false, error: unavailable },
        },
        latencyMs: Math.max(0, Date.now() - startedAt),
      }
    } catch (error) {
      throw new Error(redact(error?.message || error, site.accessToken))
    }
  }

  return { fetchSnapshot, testConnection, fetchDashboardSite }
}
