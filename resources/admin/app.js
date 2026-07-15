const SESSION_KEY = 'newapi-monitor-session'

const elements = {
  authView: document.querySelector('#auth-view'),
  authMessage: document.querySelector('#auth-message'),
  appView: document.querySelector('#app-view'),
  dashboardTab: document.querySelector('#dashboard-tab'),
  configTab: document.querySelector('#config-tab'),
  dashboardSection: document.querySelector('#dashboard-section'),
  configSection: document.querySelector('#config-section'),
  dashboardRefresh: document.querySelector('#dashboard-refresh'),
  dashboardRefreshText: document.querySelector('#dashboard-refresh-text'),
  dashboardUpdated: document.querySelector('#dashboard-updated'),
  dashboardSiteCount: document.querySelector('#dashboard-site-count'),
  dashboardTotalBalance: document.querySelector('#dashboard-total-balance'),
  dashboardBalanceScope: document.querySelector('#dashboard-balance-scope'),
  dashboardAnalyticsCount: document.querySelector('#dashboard-analytics-count'),
  dashboardSites: document.querySelector('#dashboard-sites'),
  siteList: document.querySelector('#site-list'),
  siteCount: document.querySelector('#site-count'),
  addButton: document.querySelector('#add-button'),
  emptyAddButton: document.querySelector('#empty-add-button'),
  emptyState: document.querySelector('#empty-state'),
  editorSection: document.querySelector('#editor-section'),
  editorTitle: document.querySelector('#editor-title'),
  siteRuntime: document.querySelector('#site-runtime'),
  form: document.querySelector('#site-form'),
  enabled: document.querySelector('#enabled-input'),
  name: document.querySelector('#name-input'),
  baseUrl: document.querySelector('#url-input'),
  userId: document.querySelector('#user-id-input'),
  token: document.querySelector('#token-input'),
  tokenHelp: document.querySelector('#token-help'),
  quota: document.querySelector('#quota-input'),
  threshold: document.querySelector('#threshold-input'),
  group: document.querySelector('#group-select'),
  connectionResult: document.querySelector('#connection-result'),
  saveButton: document.querySelector('#save-button'),
  testButton: document.querySelector('#test-button'),
  deleteButton: document.querySelector('#delete-button'),
  status: document.querySelector('#status-region'),
}

const state = {
  session: '',
  config: null,
  runtime: { sites: {} },
  dashboard: null,
  currentView: 'dashboard',
  selectedId: '',
  knownGroups: new Map(),
  statusTimer: null,
}

function selectedSite() {
  return state.config?.sites.find(site => site.id === state.selectedId) || null
}

function formatNumber(value, maximumFractionDigits = 4) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits,
  }).format(number)
}

function dashboardEmpty(message, error = false) {
  elements.dashboardSites.replaceChildren()
  const row = document.createElement('tr')
  const cell = document.createElement('td')
  cell.colSpan = 5
  const text = document.createElement('span')
  text.className = `dashboard-empty ${error ? 'dashboard-empty-error' : ''}`.trim()
  text.textContent = message
  cell.append(text)
  row.append(cell)
  elements.dashboardSites.append(row)
}

function dashboardPeriodCell(period, label) {
  const cell = document.createElement('td')
  cell.dataset.label = label
  if (period?.ok) {
    const requests = document.createElement('strong')
    requests.textContent = `${formatNumber(period.requestCount, 0)} 次请求`
    const used = document.createElement('small')
    used.textContent = `消耗 ${formatNumber(period.usedBalance)} 余额`
    cell.append(requests, used)
    return cell
  }

  const unavailable = document.createElement('strong')
  unavailable.className = 'dashboard-value-error'
  unavailable.textContent = '日志不可用'
  const error = document.createElement('small')
  error.textContent = period?.error || '未获取到日志统计'
  cell.append(unavailable, error)
  return cell
}

function renderDashboard(dashboard) {
  state.dashboard = dashboard
  elements.dashboardSiteCount.textContent = formatNumber(dashboard.totalSites, 0)
  elements.dashboardTotalBalance.textContent = dashboard.balanceAvailableSites
    ? formatNumber(dashboard.totalBalance)
    : '--'
  elements.dashboardBalanceScope.textContent = `${dashboard.balanceAvailableSites} / ${dashboard.totalSites} 个站点已获取`
  elements.dashboardAnalyticsCount.textContent = `${dashboard.analyticsAvailableSites} / ${dashboard.totalSites}`
  elements.dashboardUpdated.textContent = dashboard.checkedAt
    ? `更新于 ${new Date(dashboard.checkedAt).toLocaleString('zh-CN', { hour12: false })}`
    : '尚未更新'
  elements.dashboardSites.replaceChildren()

  if (!dashboard.sites.length) {
    dashboardEmpty('暂无已配置站点')
    return
  }

  for (const site of dashboard.sites) {
    const row = document.createElement('tr')

    const siteCell = document.createElement('td')
    siteCell.dataset.label = '站点'
    const siteButton = document.createElement('button')
    siteButton.type = 'button'
    siteButton.className = 'dashboard-site-link'
    siteButton.textContent = site.name
    siteButton.addEventListener('click', () => {
      showView('config')
      selectSite(site.id)
    })
    const host = document.createElement('small')
    host.textContent = site.host
    siteCell.append(siteButton, host)

    const balanceCell = document.createElement('td')
    balanceCell.dataset.label = '当前余额'
    const balance = document.createElement('strong')
    balance.textContent = site.balance === null ? '不可用' : formatNumber(site.balance)
    if (site.balance === null) balance.className = 'dashboard-value-error'
    const balanceDetail = document.createElement('small')
    balanceDetail.textContent = site.balance === null
      ? site.balanceError || '未获取到账户余额'
      : site.currentGroup ? `当前分组 ${site.currentGroup}` : '账户连接正常'
    balanceCell.append(balance, balanceDetail)

    const statusCell = document.createElement('td')
    statusCell.dataset.label = '状态'
    const balanceOk = site.balance !== null
    const analyticsOk = site.periods.oneHour.ok && site.periods.twentyFourHours.ok
    const status = document.createElement('span')
    status.className = `dashboard-status ${balanceOk && analyticsOk ? 'dashboard-status-ok' : 'dashboard-status-warning'}`
    status.textContent = !balanceOk ? '连接失败' : analyticsOk ? '数据完整' : '日志不可用'
    const monitorState = document.createElement('small')
    monitorState.textContent = site.enabled ? `监控已启用 · ${formatNumber(site.latencyMs, 0)} ms` : '监控已停用'
    statusCell.append(status, monitorState)

    row.append(
      siteCell,
      balanceCell,
      dashboardPeriodCell(site.periods.oneHour, '近 1 小时'),
      dashboardPeriodCell(site.periods.twentyFourHours, '近 24 小时'),
      statusCell,
    )
    elements.dashboardSites.append(row)
  }
}

async function loadDashboard({ announce = false } = {}) {
  elements.dashboardRefresh.disabled = true
  elements.dashboardRefreshText.textContent = '刷新中...'
  try {
    renderDashboard(await api('/api/dashboard'))
    if (announce) showStatus('总览数据已刷新', 'success')
  } catch (error) {
    elements.dashboardUpdated.textContent = '读取失败'
    dashboardEmpty(`总览读取失败：${error.message}`, true)
    showStatus(error.message, 'error')
  } finally {
    elements.dashboardRefresh.disabled = false
    elements.dashboardRefreshText.textContent = '刷新'
  }
}

function showView(view) {
  const dashboard = view !== 'config'
  state.currentView = dashboard ? 'dashboard' : 'config'
  elements.dashboardSection.hidden = !dashboard
  elements.configSection.hidden = dashboard
  elements.dashboardTab.setAttribute('aria-selected', String(dashboard))
  elements.configTab.setAttribute('aria-selected', String(!dashboard))
  if (dashboard && !state.dashboard && state.session) void loadDashboard()
}

function showStatus(message, type = '') {
  clearTimeout(state.statusTimer)
  elements.status.textContent = message
  elements.status.className = `status-region visible ${type}`.trim()
  state.statusTimer = setTimeout(() => {
    elements.status.className = 'status-region'
  }, 3200)
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (state.session) headers.set('Authorization', `Bearer ${state.session}`)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(path, { ...options, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(SESSION_KEY)
    throw new Error(payload.error || `请求失败（HTTP ${response.status}）`)
  }
  return payload
}

function setConnectionResult(message, type = '') {
  elements.connectionResult.hidden = !message
  elements.connectionResult.className = `result-band ${type}`.trim()
  elements.connectionResult.textContent = message
}

function runtimeText(site) {
  const runtime = state.runtime?.sites?.[site.id]
  if (!runtime) return '尚无监控记录'
  if (runtime.lastError) return `最近检查失败：${runtime.lastError}`
  const parts = []
  if (runtime.lastBalance !== undefined) parts.push(`最近余额 ${runtime.lastBalance}`)
  const ratios = runtime.lastGroupRatios && typeof runtime.lastGroupRatios === 'object'
    ? runtime.lastGroupRatios
    : runtime.lastGroup && runtime.lastGroupRatio !== undefined
      ? { [runtime.lastGroup]: runtime.lastGroupRatio }
      : {}
  if (Object.keys(ratios).length) {
    parts.push(Object.entries(ratios).map(([group, ratio]) => `${group} 倍率 ${ratio}`).join('；'))
  }
  return parts.length ? parts.join(' · ') : '等待首次检查'
}

function checkedGroups() {
  return [...elements.group.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => input.value)
}

function updateSelectedFromForm() {
  const site = selectedSite()
  if (!site) return
  site.name = elements.name.value
  site.baseUrl = elements.baseUrl.value
  site.userId = elements.userId.value
  site.accessToken = elements.token.value
  site.quotaPerUnit = elements.quota.value
  site.balanceThreshold = elements.threshold.value
  if (state.knownGroups.has(site.id)) site.monitoredGroups = checkedGroups()
  site.enabled = elements.enabled.checked
  elements.editorTitle.textContent = site.name.trim() || '未命名站点'
  renderSites()
}

function renderGroups(site) {
  const groups = state.knownGroups.get(site.id)
  elements.group.replaceChildren()
  const selected = Array.isArray(site.monitoredGroups) ? site.monitoredGroups : []
  if (!groups?.length) {
    const placeholder = document.createElement('span')
    placeholder.className = 'group-empty'
    placeholder.textContent = selected.length
      ? `当前：${selected.join('、')}（测试后可修改）`
      : '请先测试连通性'
    elements.group.append(placeholder)
    elements.group.setAttribute('aria-disabled', 'true')
    return
  }

  const available = new Set(groups.map(group => group.key))
  const preferred = selected.filter(group => available.has(group))
  if (!preferred.length && !selected.length) preferred.push(groups[0].key)
  const rows = [
    ...groups.map(group => ({ ...group, missing: false })),
    ...selected.filter(group => !available.has(group)).map(key => ({
      key, label: key, ratio: null, missing: true,
    })),
  ]
  site.monitoredGroups = [...new Set([...preferred, ...selected.filter(group => !available.has(group))])]

  for (const group of rows) {
    const option = document.createElement('label')
    option.className = `group-option ${group.missing ? 'group-option-missing' : ''}`.trim()
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.name = 'monitoredGroups'
    checkbox.value = group.key
    checkbox.checked = site.monitoredGroups.includes(group.key)
    const text = document.createElement('span')
    text.className = 'group-option-text'
    const title = document.createElement('span')
    title.textContent = `${group.label} (${group.key})`
    const detail = document.createElement('small')
    detail.textContent = group.missing ? '当前接口未返回，可取消选择' : `当前倍率 ${group.ratio}`
    text.append(title, detail)
    option.append(checkbox, text)
    elements.group.append(option)
  }
  elements.group.setAttribute('aria-disabled', 'false')
}

function renderSites() {
  elements.siteList.replaceChildren()
  const sites = state.config?.sites || []
  elements.siteCount.textContent = `${sites.length} 个站点`

  for (const site of sites) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'site-item'
    button.setAttribute('aria-current', String(site.id === state.selectedId))
    button.addEventListener('click', () => selectSite(site.id))

    const dot = document.createElement('span')
    dot.className = `status-dot ${state.runtime?.sites?.[site.id]?.lastError ? 'status-dot-error' : ''}`.trim()
    const content = document.createElement('span')
    content.className = 'site-item-content'
    const name = document.createElement('strong')
    name.textContent = site.name.trim() || '未命名站点'
    const url = document.createElement('span')
    url.textContent = site.baseUrl.trim() || '尚未填写 URL'
    content.append(name, url)
    button.append(dot, content)
    elements.siteList.append(button)
  }
}

function selectSite(id) {
  state.selectedId = id
  const site = selectedSite()
  renderSites()
  elements.emptyState.hidden = Boolean(site)
  elements.editorSection.hidden = !site
  if (!site) return

  elements.editorTitle.textContent = site.name.trim() || '未命名站点'
  elements.siteRuntime.textContent = runtimeText(site)
  elements.enabled.checked = site.enabled !== false
  elements.name.value = site.name || ''
  elements.baseUrl.value = site.baseUrl || ''
  elements.userId.value = site.userId || ''
  elements.token.value = ''
  elements.quota.value = site.quotaPerUnit || 500000
  elements.threshold.value = site.balanceThreshold ?? 0
  elements.token.placeholder = site.accessTokenConfigured ? '已配置，留空不修改' : '粘贴系统访问令牌'
  elements.tokenHelp.textContent = site.accessTokenConfigured
    ? '令牌已配置，留空不会修改。在 New API 个人设置的“系统访问令牌”处可重新获取。'
    : '在 New API 个人设置的“系统访问令牌”处获取，并填写对应用户 ID。'
  renderGroups(site)
  setConnectionResult('')
}

function addSite() {
  const id = crypto.randomUUID()
  state.config.sites.push({
    id,
    name: `站点 ${state.config.sites.length + 1}`,
    baseUrl: '',
    userId: '',
    accessToken: '',
    accessTokenConfigured: false,
    quotaPerUnit: 500000,
    balanceThreshold: 5,
    monitoredGroups: [],
    enabled: true,
  })
  selectSite(id)
  elements.name.focus()
}

function validateSite(site, { requireGroup = false } = {}) {
  if (!site.name.trim()) throw new Error('请填写站点名称')
  if (!site.baseUrl.trim()) throw new Error('请填写站点 URL')
  if (!String(site.userId).trim()) throw new Error('请填写 New API 用户 ID')
  if (!site.accessToken.trim() && !site.accessTokenConfigured) throw new Error('请填写个人系统访问令牌')
  if (!(Number(site.quotaPerUnit) > 0)) throw new Error('额度换算值必须大于 0')
  if (!(Number(site.balanceThreshold) >= 0)) throw new Error('余额预警阈值不能小于 0')
  if (requireGroup && !site.monitoredGroups?.length) throw new Error('请先测试连通性并至少选择一个监控分组')
}

async function testConnection() {
  updateSelectedFromForm()
  const site = selectedSite()
  try {
    validateSite(site)
    elements.testButton.disabled = true
    elements.saveButton.disabled = true
    elements.testButton.textContent = '测试中...'
    setConnectionResult('正在连接站点并获取账户与分组信息...')
    const result = await api('/api/sites/test', {
      method: 'POST',
      body: JSON.stringify({
        id: site.id,
        baseUrl: site.baseUrl,
        userId: site.userId,
        accessToken: site.accessToken,
      }),
    })
    site.baseUrl = result.baseUrl
    elements.baseUrl.value = result.baseUrl
    state.knownGroups.set(site.id, result.groups)
    renderGroups(site)
    const balance = Number(result.account.quota) / Number(site.quotaPerUnit)
    setConnectionResult([
      `连接成功 · ${result.latencyMs} ms`,
      `账户：${result.account.displayName || result.account.username || '未知'} · 当前分组 ${result.account.currentGroup}`,
      `当前余额：${Number.isFinite(balance) ? balance : '无法换算'} · 获取到 ${result.groups.length} 个分组 · 已选择 ${site.monitoredGroups.length} 个`,
    ].join('\n'), 'success')
    showStatus('连接成功，分组列表已更新', 'success')
  } catch (error) {
    setConnectionResult(`连接失败：${error.message}`, 'error')
    showStatus(error.message, 'error')
  } finally {
    elements.testButton.disabled = false
    elements.saveButton.disabled = false
    elements.testButton.textContent = '测试连通性并获取分组'
  }
}

async function saveConfig(event) {
  event.preventDefault()
  updateSelectedFromForm()
  const site = selectedSite()
  try {
    validateSite(site, { requireGroup: true })
    elements.saveButton.disabled = true
    elements.testButton.disabled = true
    elements.saveButton.textContent = '保存中...'
    state.config = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify(state.config),
    })
    state.dashboard = null
    selectSite(site.id)
    showStatus('配置已保存，监控任务将在下一分钟使用新配置', 'success')
  } catch (error) {
    showStatus(error.message, 'error')
  } finally {
    elements.saveButton.disabled = false
    elements.testButton.disabled = false
    elements.saveButton.textContent = '保存配置'
  }
}

async function deleteSite() {
  const site = selectedSite()
  if (!site || !window.confirm(`确定删除站点“${site.name || '未命名站点'}”吗？`)) return
  const previousConfig = structuredClone(state.config)
  const previousId = state.selectedId
  state.config.sites = state.config.sites.filter(item => item.id !== site.id)
  state.knownGroups.delete(site.id)
  try {
    elements.deleteButton.disabled = true
    state.config = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify(state.config),
    })
    state.dashboard = null
    selectSite(state.config.sites[0]?.id || '')
    showStatus('站点已删除', 'success')
  } catch (error) {
    state.config = previousConfig
    selectSite(previousId)
    showStatus(error.message, 'error')
  } finally {
    elements.deleteButton.disabled = false
  }
}

async function refreshRuntime() {
  if (!state.session) return
  try {
    state.runtime = await api('/api/runtime')
    renderSites()
    const site = selectedSite()
    if (site) elements.siteRuntime.textContent = runtimeText(site)
  } catch (error) {
    if (!state.session) return
    showStatus(`运行状态刷新失败：${error.message}`, 'error')
  }
}

async function authenticate() {
  const loginToken = new URLSearchParams(window.location.search).get('token')
  if (loginToken) {
    try {
      const response = await fetch('/api/auth/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: loginToken }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || '登录链接无效')
      state.session = payload.sessionToken
      sessionStorage.setItem(SESSION_KEY, state.session)
    } finally {
      history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
    }
  } else {
    state.session = sessionStorage.getItem(SESSION_KEY) || ''
  }

  if (!state.session) throw new Error('请向机器人发送 #NewAPI监控登录 获取新的主人登录链接')
}

async function initialize() {
  try {
    await authenticate()
    const [config, runtime] = await Promise.all([api('/api/config'), api('/api/runtime')])
    state.config = config
    state.runtime = runtime
    state.selectedId = config.sites[0]?.id || ''
    elements.authView.hidden = true
    elements.appView.hidden = false
    selectSite(state.selectedId)
    showView('dashboard')
    setInterval(refreshRuntime, 30_000)
  } catch (error) {
    elements.authMessage.textContent = error.message
  }
}

elements.addButton.addEventListener('click', addSite)
elements.emptyAddButton.addEventListener('click', addSite)
elements.dashboardTab.addEventListener('click', () => showView('dashboard'))
elements.configTab.addEventListener('click', () => showView('config'))
elements.dashboardRefresh.addEventListener('click', () => loadDashboard({ announce: true }))
elements.testButton.addEventListener('click', testConnection)
elements.deleteButton.addEventListener('click', deleteSite)
elements.form.addEventListener('submit', saveConfig)
elements.form.addEventListener('input', updateSelectedFromForm)
elements.form.addEventListener('change', updateSelectedFromForm)

initialize()
