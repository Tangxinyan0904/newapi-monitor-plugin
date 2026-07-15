function number(value) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 8 })
}

function timestamp(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function formatEvent(event) {
  if (event.type === 'balance-low') {
    return [
      '[NewAPI Monitor] 余额预警',
      `站点：${event.siteName} (${event.host})`,
      `当前余额：${number(event.balance)}`,
      `预警阈值：${number(event.threshold)}`,
      `账号分组：${event.currentGroup || '未知'}`,
      `检查时间：${timestamp(event.checkedAt)}`,
    ].join('\n')
  }

  if (event.type === 'group-ratio-changed') {
    return [
      '[NewAPI Monitor] 分组倍率变动',
      `站点：${event.siteName} (${event.host})`,
      `监控分组：${event.group}`,
      `倍率变化：${number(event.previousRatio)} -> ${number(event.currentRatio)}`,
      `检查时间：${timestamp(event.checkedAt)}`,
    ].join('\n')
  }

  return '[NewAPI Monitor] 未知监控事件'
}

export async function notifyOwners(events) {
  if (!events?.length) return
  if (events.length === 1) {
    await Bot.sendMasterMsg(formatEvent(events[0]))
    return
  }

  const nodes = events.map(event => ({ message: formatEvent(event) }))
  await Bot.sendMasterMsg(await Bot.makeForwardMsg(nodes))
}
