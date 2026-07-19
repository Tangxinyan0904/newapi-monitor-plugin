import crypto from 'node:crypto'
import express from 'express'

function randomToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function tokenEquals(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function findToken(map, presented) {
  for (const [token, record] of map) {
    if (tokenEquals(token, presented)) return { token, record }
  }
  return null
}

function sanitizedAccount(account = {}) {
  return {
    username: String(account.username ?? ''),
    displayName: String(account.displayName ?? ''),
    currentGroup: String(account.currentGroup ?? 'default'),
    quota: Number(account.quota ?? 0),
    usedQuota: Number(account.usedQuota ?? 0),
    requestCount: Number(account.requestCount ?? 0),
  }
}

function sanitizedGroups(groups = []) {
  return groups.map(group => ({
    key: String(group.key),
    label: String(group.label ?? group.key),
    ratio: Number(group.ratio),
  }))
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length || 1))

  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host
  } catch {
    return String(baseUrl ?? '')
  }
}

function safeError(error, secret) {
  const message = String(error?.message || error || 'Request failed')
  return secret ? message.split(secret).join('[redacted]') : message
}

function dashboardPeriod(period, site) {
  if (!period?.ok) return { ok: false, error: safeError(period?.error, site.accessToken) }
  const requestCount = Number(period.requestCount)
  const usedQuota = Number(period.usedQuota)
  const quotaPerUnit = Number(site.quotaPerUnit)
  if (!Number.isSafeInteger(requestCount) || requestCount < 0 || !Number.isFinite(usedQuota)) {
    return { ok: false, error: 'Invalid personal log statistics response' }
  }
  return {
    ok: true,
    requestCount,
    usedBalance: usedQuota / quotaPerUnit,
  }
}

function dashboardSite(site, result) {
  const rawQuota = result.account?.quota
  const quota = Number(rawQuota)
  const hasQuota = rawQuota !== null
    && rawQuota !== undefined
    && String(rawQuota).trim() !== ''
    && Number.isFinite(quota)
  const directBalance = Number(result.balance)
  const balance = Number.isFinite(directBalance)
    ? directBalance
    : result.account && hasQuota
      ? quota / Number(site.quotaPerUnit)
      : null
  return {
    id: site.id,
    name: site.name,
    baseUrl: String(result.baseUrl || site.baseUrl),
    host: hostOf(result.baseUrl || site.baseUrl),
    enabled: site.enabled !== false,
    currentGroup: String(result.account?.currentGroup ?? ''),
    balance,
    balanceError: balance === null
      ? safeError(result.accountError || 'Balance unavailable', site.accessToken)
      : '',
    periods: {
      oneHour: dashboardPeriod(result.periods?.oneHour, site),
      twentyFourHours: dashboardPeriod(result.periods?.twentyFourHours, site),
    },
    latencyMs: Number(result.latencyMs ?? 0),
  }
}

function failedDashboardSite(site, error) {
  const message = safeError(error, site.accessToken)
  return {
    id: site.id,
    name: site.name,
    baseUrl: String(site.baseUrl),
    host: hostOf(site.baseUrl),
    enabled: site.enabled !== false,
    currentGroup: '',
    balance: null,
    balanceError: message,
    periods: {
      oneHour: { ok: false, error: message },
      twentyFourHours: { ok: false, error: message },
    },
    latencyMs: 0,
  }
}

export class AdminServer {
  constructor({ configStore, stateStore, client, engine, resourcesDir, now = () => Date.now() }) {
    this.configStore = configStore
    this.stateStore = stateStore
    this.client = client
    this.engine = engine
    this.resourcesDir = resourcesDir
    this.now = now
    this.loginTokens = new Map()
    this.sessions = new Map()
    this.server = null
    this.address = null
    this.starting = null
    this.app = this.createApp()
  }

  createApp() {
    const app = express()
    app.disable('x-powered-by')
    app.use((req, res, next) => {
      res.set({
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      })
      next()
    })
    app.use(express.json({ limit: '64kb' }))

    app.get('/', (req, res) => res.sendFile('index.html', { root: this.resourcesDir }))
    app.get('/style.css', (req, res) => res.sendFile('style.css', { root: this.resourcesDir }))
    app.get('/app.js', (req, res) => res.sendFile('app.js', { root: this.resourcesDir }))

    app.post('/api/auth/exchange', (req, res) => {
      const found = findToken(this.loginTokens, req.body?.token)
      if (!found) return res.status(401).json({ error: '登录令牌无效或已使用' })

      this.loginTokens.delete(found.token)
      if (found.record.expiresAt <= this.now()) {
        return res.status(401).json({ error: '登录令牌已过期' })
      }

      const config = this.configStore.load()
      const sessionToken = randomToken()
      const expiresAt = this.now() + config.web.sessionTtlSeconds * 1000
      this.sessions.set(sessionToken, { ownerId: found.record.ownerId, expiresAt })
      return res.json({ sessionToken, expiresAt })
    })

    app.use('/api', (req, res, next) => {
      const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)
      const found = match && findToken(this.sessions, match[1])
      if (!found) return res.status(401).json({ error: '未登录或会话无效' })
      if (found.record.expiresAt <= this.now()) {
        this.sessions.delete(found.token)
        return res.status(401).json({ error: '会话已过期' })
      }
      req.ownerId = found.record.ownerId
      return next()
    })

    app.get('/api/config', (req, res) => res.json(this.configStore.browserView()))

    app.put('/api/config', (req, res, next) => {
      try {
        const saved = this.configStore.saveBrowser(req.body)
        const configuredIds = new Set(saved.sites.map(site => site.id))
        const runtimeState = this.stateStore.load()
        let runtimeChanged = false
        for (const siteId of Object.keys(runtimeState.sites || {})) {
          if (!configuredIds.has(siteId)) {
            delete runtimeState.sites[siteId]
            runtimeChanged = true
          }
        }
        if (runtimeChanged) this.stateStore.save(runtimeState)
        res.json(this.configStore.browserView())
      } catch (error) {
        next(error)
      }
    })

    app.post('/api/sites/test', async (req, res, next) => {
      try {
        const body = req.body || {}
        const existing = this.configStore.load().sites.find(site => site.id === String(body.id ?? ''))
        const submittedToken = String(body.accessToken ?? '').trim()
        const result = await this.client.testConnection({
          type: String(body.type ?? existing?.type ?? 'newapi'),
          baseUrl: body.baseUrl,
          userId: body.userId,
          accessToken: submittedToken || existing?.accessToken || '',
        })
        res.json({
          type: String(body.type ?? existing?.type ?? 'newapi'),
          baseUrl: result.baseUrl,
          balance: Number.isFinite(Number(result.balance)) ? Number(result.balance) : null,
          account: sanitizedAccount(result.account),
          groups: sanitizedGroups(result.groups),
          latencyMs: Number(result.latencyMs ?? 0),
        })
      } catch (error) {
        next(error)
      }
    })

    app.post('/api/sites/check', async (req, res, next) => {
      try {
        const siteId = String(req.body?.id ?? '').trim()
        if (!siteId) return res.status(400).json({ error: '站点 ID 不能为空' })
        const site = this.configStore.load().sites.find(item => item.id === siteId)
        if (!site) return res.status(404).json({ error: '站点不存在' })
        if (!this.engine?.runSite) throw new Error('Monitor engine is unavailable')

        const outcome = await this.engine.runSite(siteId)
        if (outcome.status === 'missing') return res.status(404).json({ error: '站点不存在' })
        const result = outcome.result
          ? {
              siteId: String(outcome.result.siteId ?? siteId),
              ok: Boolean(outcome.result.ok),
              error: outcome.result.error
                ? safeError(outcome.result.error, site.accessToken)
                : '',
              balance: Number.isFinite(Number(outcome.result.balance))
                ? Number(outcome.result.balance)
                : null,
              threshold: Number.isFinite(Number(outcome.result.threshold))
                ? Number(outcome.result.threshold)
                : null,
              checkedAt: Number(outcome.result.checkedAt ?? 0),
            }
          : null
        return res.json({
          status: String(outcome.status),
          alertSent: outcome.events.some(event => event.type === 'balance-low'),
          result,
        })
      } catch (error) {
        next(error)
      }
    })

    app.get('/api/runtime', (req, res) => res.json(this.stateStore.load()))

    app.get('/api/dashboard', async (req, res, next) => {
      try {
        const config = this.configStore.load()
        const checkedAt = this.now()
        const sites = await mapLimit(
          config.sites,
          config.monitor?.concurrency ?? 3,
          async site => {
            try {
              const result = await this.client.fetchDashboardSite(site, {
                nowSeconds: Math.floor(checkedAt / 1000),
              })
              return dashboardSite(site, result)
            } catch (error) {
              return failedDashboardSite(site, error)
            }
          },
        )
        const balanceSites = sites.filter(site => Number.isFinite(site.balance))
        res.json({
          checkedAt,
          totalSites: sites.length,
          balanceAvailableSites: balanceSites.length,
          analyticsAvailableSites: sites.filter(site => (
            site.periods.oneHour.ok && site.periods.twentyFourHours.ok
          )).length,
          totalBalance: balanceSites.reduce((total, site) => total + site.balance, 0),
          sites,
        })
      } catch (error) {
        next(error)
      }
    })

    app.use((error, req, res, next) => {
      if (error?.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求内容超过 64 KiB 限制' })
      }
      const status = Number(error?.status) >= 400 && Number(error?.status) < 500
        ? Number(error.status)
        : 400
      return res.status(status).json({ error: String(error?.message || '请求失败') })
    })
    return app
  }

  issueLoginToken(ownerId) {
    const config = this.configStore.load()
    const token = randomToken()
    this.loginTokens.set(token, {
      ownerId: String(ownerId),
      expiresAt: this.now() + config.web.loginTokenTtlSeconds * 1000,
    })
    return token
  }

  loginUrl(token) {
    const url = new URL(this.configStore.load().web.publicUrl)
    url.searchParams.set('token', token)
    return url.toString()
  }

  async start() {
    if (this.server) return this.address
    if (this.starting) return this.starting
    const { host, port } = this.configStore.load().web
    this.starting = new Promise((resolve, reject) => {
      const listener = this.app.listen(port, host)
      listener.once('error', error => reject(error))
      listener.once('listening', () => {
        this.server = listener
        this.address = listener.address()
        resolve(this.address)
      })
    })
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  async stop() {
    const listener = this.server
    this.server = null
    this.address = null
    this.loginTokens.clear()
    this.sessions.clear()
    if (!listener) return
    await new Promise((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve())
    })
  }
}
