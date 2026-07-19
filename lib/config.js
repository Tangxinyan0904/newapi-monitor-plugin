import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { normalizeBaseUrl } from './url.js'

export function defaultConfig() {
  return {
    web: {
      host: '127.0.0.1',
      port: 25095,
      publicUrl: 'http://127.0.0.1:25095',
      loginTokenTtlSeconds: 300,
      sessionTtlSeconds: 3600,
    },
    monitor: {
      cron: '0 * * * * *',
      concurrency: 3,
      timeoutMs: 10000,
    },
    sites: [],
  }
}

function positiveInteger(value, fallback, field, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number <= 0 || number > max) {
    throw new Error(`${field} must be a positive integer`)
  }
  return number
}

function nonNegativeNumber(value, fallback, field) {
  const number = Number(value ?? fallback)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must not be below zero`)
  return number
}

function normalizedPublicUrl(value, fallback) {
  const url = new URL(String(value || fallback).trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('web.publicUrl must use HTTP or HTTPS')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function normalizedGroups(input) {
  const values = Array.isArray(input?.monitoredGroups)
    ? input.monitoredGroups
    : [input?.monitoredGroup]
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function normalizeSite(input, index) {
  const id = String(input?.id ?? '').trim()
  const name = String(input?.name ?? '').trim()
  const type = String(input?.type ?? 'newapi').trim().toLowerCase() || 'newapi'
  if (!['newapi', 'sub2api'].includes(type)) {
    throw new Error(`sites[${index}].type must be newapi or sub2api`)
  }
  const userId = type === 'newapi'
    ? positiveInteger(input?.userId, undefined, `sites[${index}].userId`)
    : undefined
  const quotaPerUnit = Number(input?.quotaPerUnit ?? (type === 'sub2api' ? 1 : 500000))
  const balanceThreshold = nonNegativeNumber(
    input?.balanceThreshold,
    0,
    `sites[${index}].balanceThreshold`,
  )

  if (!id) throw new Error(`sites[${index}].id is required`)
  if (!name) throw new Error(`sites[${index}].name is required`)
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
    throw new Error(`sites[${index}].quotaPerUnit must be positive`)
  }

  const monitoredGroups = type === 'sub2api'
    ? ['__sub2api_current_key__']
    : normalizedGroups(input)

  return {
    id,
    name,
    type,
    baseUrl: normalizeBaseUrl(input?.baseUrl),
    userId,
    accessToken: String(input?.accessToken ?? '').trim(),
    quotaPerUnit,
    balanceThreshold,
    monitoredGroups,
    enabled: input?.enabled !== false,
  }
}

export function normalizeConfig(input = {}) {
  const defaults = defaultConfig()
  const web = input.web || {}
  const monitor = input.monitor || {}
  const sites = (Array.isArray(input.sites) ? input.sites : []).map(normalizeSite)
  const ids = new Set()

  for (const site of sites) {
    if (ids.has(site.id)) throw new Error('Site ids must be unique')
    ids.add(site.id)
  }

  return {
    web: {
      host: String(web.host || defaults.web.host).trim() || defaults.web.host,
      port: positiveInteger(web.port, defaults.web.port, 'web.port', 65535),
      publicUrl: normalizedPublicUrl(web.publicUrl, defaults.web.publicUrl),
      loginTokenTtlSeconds: positiveInteger(
        web.loginTokenTtlSeconds,
        defaults.web.loginTokenTtlSeconds,
        'web.loginTokenTtlSeconds',
      ),
      sessionTtlSeconds: positiveInteger(
        web.sessionTtlSeconds,
        defaults.web.sessionTtlSeconds,
        'web.sessionTtlSeconds',
      ),
    },
    monitor: {
      cron: String(monitor.cron || defaults.monitor.cron).trim() || defaults.monitor.cron,
      concurrency: positiveInteger(
        monitor.concurrency,
        defaults.monitor.concurrency,
        'monitor.concurrency',
        20,
      ),
      timeoutMs: positiveInteger(
        monitor.timeoutMs,
        defaults.monitor.timeoutMs,
        'monitor.timeoutMs',
        120000,
      ),
    },
    sites,
  }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temp, file)
}

export function createConfigStore({
  pluginRoot = path.resolve('plugins/newapi-monitor-plugin'),
} = {}) {
  const configFile = path.join(pluginRoot, 'config/config.yaml')
  const exampleFile = path.join(pluginRoot, 'config/config.example.yaml')

  function save(config) {
    const normalized = normalizeConfig(config)
    atomicWrite(configFile, YAML.stringify(normalized))
    return normalized
  }

  function load() {
    if (!fs.existsSync(configFile)) {
      fs.mkdirSync(path.dirname(configFile), { recursive: true })
      if (fs.existsSync(exampleFile)) fs.copyFileSync(exampleFile, configFile)
      else return save(defaultConfig())
    }

    const text = fs.readFileSync(configFile, 'utf8')
    return normalizeConfig(YAML.parse(text) || {})
  }

  function browserView() {
    const config = load()
    return {
      ...config,
      sites: config.sites.map(site => ({
        ...site,
        accessToken: '',
        accessTokenConfigured: Boolean(site.accessToken),
      })),
    }
  }

  function saveBrowser(input = {}) {
    const current = load()
    const currentById = new Map(current.sites.map(site => [site.id, site]))
    const submittedSites = Array.isArray(input.sites) ? input.sites : []
    const merged = submittedSites.map(site => {
      const submittedToken = String(site?.accessToken ?? '').trim()
      return {
        ...site,
        accessToken: submittedToken || currentById.get(String(site?.id))?.accessToken || '',
      }
    })

    return save({
      web: input.web,
      monitor: input.monitor,
      sites: merged,
    })
  }

  return { load, save, browserView, saveBrowser, configFile }
}
