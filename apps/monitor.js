import plugin from '../../../lib/plugins/plugin.js'
import { getRuntime } from '../lib/runtime.js'

function number(value) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 8 })
}

function formatSummary(item) {
  if (!item.ok && !item.groups?.length) {
    return [
      `[NewAPI] ${item.siteName} (${item.host})`,
      `查询失败：${item.error}`,
    ].join('\n')
  }

  const lines = [
    `[NewAPI] ${item.siteName} (${item.host})`,
    `余额：${number(item.balance)} / 阈值 ${number(item.threshold)}`,
    `监控分组：${item.groups.map(group => group.key).join('、')}`,
    ...item.groups.map(group => `- ${group.label} (${group.key})：${number(group.ratio)}`),
    `接口延迟：${number(item.latencyMs)} ms`,
  ]
  if (item.error) lines.push(`分组异常：${item.error}`)
  return lines.join('\n')
}

export default class NewApiMonitor extends plugin {
  constructor() {
    super({
      name: 'NewAPI 余额监控',
      dsc: '查询 New API 余额与分组倍率',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: '^#NewAPI余额$',
          fnc: 'queryBalance',
          permission: 'master',
        },
      ],
    })

    this.task = {
      name: '[NewAPI Monitor] 每分钟检查',
      cron: getRuntime().configStore.load().monitor.cron,
      fnc: () => getRuntime().engine.runCycle(),
      log: false,
    }
  }

  async queryBalance(e) {
    const summary = await getRuntime().engine.runLiveSummary()
    if (!summary.length) {
      await e.reply('尚未配置已启用的 New API 站点')
      return true
    }

    const messages = summary.map(formatSummary)
    if (messages.length === 1) await e.reply(messages[0])
    else await e.reply(await Bot.makeForwardMsg(messages.map(message => ({ message }))))
    return true
  }
}
