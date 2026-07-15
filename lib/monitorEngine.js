import crypto from 'node:crypto'

export function evaluateBalance({ balance, threshold, alerted }) {
  const low = Number(balance) < Number(threshold)
  return {
    low,
    notify: low && !alerted,
    nextAlerted: low,
  }
}

export function evaluateRatio({ previous, current }) {
  const initialized = previous !== null && previous !== undefined
  return {
    initialized,
    changed: initialized && Number(previous) !== Number(current),
  }
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

function messageOf(error, secret) {
  const message = String(error?.message || error || 'Unknown error')
  return secret ? message.split(secret).join('[redacted]') : message
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host
  } catch {
    return String(baseUrl)
  }
}

function identityHash(site) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([site.baseUrl, String(site.userId), site.accessToken]))
    .digest('hex')
}

function monitoredGroupKeys(site) {
  const values = Array.isArray(site.monitoredGroups) ? site.monitoredGroups : [site.monitoredGroup]
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function selectedGroups(site, snapshot) {
  const keys = monitoredGroupKeys(site)
  if (!keys.length) throw new Error('At least one monitored group must be selected')
  const byKey = new Map(snapshot.groups.map(group => [group.key, group]))
  return {
    keys,
    groups: keys.map(key => byKey.get(key)).filter(Boolean),
    missing: keys.filter(key => !byKey.has(key)),
  }
}

function previousGroupRatios(previous) {
  const ratios = previous.lastGroupRatios && typeof previous.lastGroupRatios === 'object'
    ? { ...previous.lastGroupRatios }
    : {}
  if (previous.lastGroup && previous.lastGroupRatio !== undefined && ratios[previous.lastGroup] === undefined) {
    ratios[previous.lastGroup] = previous.lastGroupRatio
  }
  return ratios
}

function missingGroupsMessage(missing) {
  return missing.length ? `Selected groups not found: ${missing.join(', ')}` : ''
}

function summaryOf(site, snapshot) {
  const balance = Number(snapshot.account.quota) / Number(site.quotaPerUnit)
  if (!Number.isFinite(balance)) throw new Error('Account quota could not be converted to balance')
  const selected = selectedGroups(site, snapshot)
  const error = missingGroupsMessage(selected.missing)
  return {
    siteId: site.id,
    siteName: site.name,
    baseUrl: snapshot.baseUrl,
    host: hostOf(snapshot.baseUrl),
    ok: !error,
    error,
    balance,
    threshold: site.balanceThreshold,
    account: snapshot.account,
    groups: selected.groups.map(group => ({
      key: group.key,
      label: group.label,
      ratio: group.ratio,
    })),
    missingGroups: selected.missing,
    latencyMs: snapshot.latencyMs,
  }
}

export function createMonitorEngine({ configStore, stateStore, client, notify, now = () => Date.now() }) {
  let running = null

  async function executeCycle() {
    const config = configStore.load()
    const sites = config.sites.filter(site => site.enabled)
    const state = stateStore.load()
    state.sites ||= {}
    const configuredIds = new Set(config.sites.map(site => site.id))
    for (const siteId of Object.keys(state.sites)) {
      if (!configuredIds.has(siteId)) delete state.sites[siteId]
    }

    const outcomes = await mapLimit(sites, config.monitor?.concurrency ?? 3, async site => {
      const checkedAt = now()
      const currentIdentityHash = identityHash(site)
      const persisted = state.sites[site.id] || {}
      const previous = persisted.identityHash === currentIdentityHash ? persisted : {}
      const next = { ...previous, identityHash: currentIdentityHash, lastCheckedAt: checkedAt }
      const events = []

      try {
        const snapshot = await client.fetchSnapshot(site)
        const balance = Number(snapshot.account.quota) / Number(site.quotaPerUnit)
        if (!Number.isFinite(balance)) throw new Error('Account quota could not be converted to balance')

        const balanceTransition = evaluateBalance({
          balance,
          threshold: site.balanceThreshold,
          alerted: Boolean(previous.balanceAlerted),
        })
        next.lastBalance = balance
        next.balanceAlerted = balanceTransition.nextAlerted

        if (balanceTransition.notify) {
          events.push({
            type: 'balance-low',
            siteId: site.id,
            siteName: site.name,
            host: hostOf(snapshot.baseUrl),
            balance,
            threshold: site.balanceThreshold,
            currentGroup: snapshot.account.currentGroup,
            checkedAt,
          })
        }

        const selected = selectedGroups(site, snapshot)
        const previousRatios = previousGroupRatios(previous)
        const nextRatios = {}
        const selectedByKey = new Map(selected.groups.map(group => [group.key, group]))
        for (const groupKey of selected.keys) {
          const group = selectedByKey.get(groupKey)
          if (!group) {
            if (previousRatios[groupKey] !== undefined) nextRatios[groupKey] = previousRatios[groupKey]
            continue
          }
          const previousRatio = previousRatios[groupKey]
          const ratioTransition = evaluateRatio({ previous: previousRatio, current: group.ratio })
          if (ratioTransition.changed) {
            events.push({
              type: 'group-ratio-changed',
              siteId: site.id,
              siteName: site.name,
              host: hostOf(snapshot.baseUrl),
              group: group.key,
              previousRatio,
              currentRatio: group.ratio,
              checkedAt,
            })
          }
          nextRatios[groupKey] = group.ratio
        }

        next.lastGroupRatios = nextRatios
        delete next.lastGroup
        delete next.lastGroupRatio
        next.lastSuccessAt = checkedAt
        next.lastError = missingGroupsMessage(selected.missing)
        if (next.lastError) {
          globalThis.logger?.warn?.(
            `[NewAPI Monitor] ${site.name} (${hostOf(site.baseUrl)}) check failed: ${next.lastError}`,
          )
        }
        state.sites[site.id] = next

        return {
          result: { ...summaryOf(site, snapshot), checkedAt },
          events,
        }
      } catch (error) {
        const message = messageOf(error, site.accessToken)
        globalThis.logger?.warn?.(
          `[NewAPI Monitor] ${site.name} (${hostOf(site.baseUrl)}) check failed: ${message}`,
        )
        next.lastError = message
        state.sites[site.id] = next
        return {
          result: {
            siteId: site.id,
            siteName: site.name,
            baseUrl: site.baseUrl,
            host: hostOf(site.baseUrl),
            ok: false,
            error: message,
            checkedAt,
          },
          events,
        }
      }
    })

    const events = outcomes.flatMap(outcome => outcome.events)
    const results = outcomes.map(outcome => outcome.result)
    stateStore.save(state)
    if (events.length) await notify(events)
    return { results, events }
  }

  async function runCycle() {
    if (running) return running
    running = executeCycle()
    try {
      return await running
    } finally {
      running = null
    }
  }

  async function runLiveSummary() {
    const config = configStore.load()
    const sites = config.sites.filter(site => site.enabled)
    return mapLimit(sites, config.monitor?.concurrency ?? 3, async site => {
      try {
        const snapshot = await client.fetchSnapshot(site)
        return { ...summaryOf(site, snapshot), checkedAt: now() }
      } catch (error) {
        return {
          siteId: site.id,
          siteName: site.name,
          baseUrl: site.baseUrl,
          host: hostOf(site.baseUrl),
          ok: false,
          error: messageOf(error, site.accessToken),
          checkedAt: now(),
        }
      }
    })
  }

  return {
    runCycle,
    runLiveSummary,
    isRunning: () => Boolean(running),
  }
}
