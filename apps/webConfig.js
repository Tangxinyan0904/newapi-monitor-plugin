import plugin from '../../../lib/plugins/plugin.js'
import { getAdminServer } from '../lib/runtime.js'

export default class NewApiWebConfig extends plugin {
  constructor() {
    super({
      name: 'NewAPI Web 配置',
      dsc: '生成 New API 监控 Web 配置登录链接',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: '^#NewAPI监控登录$',
          fnc: 'createLoginLink',
          permission: 'master',
        },
      ],
    })
  }

  async createLoginLink(e) {
    try {
      const server = getAdminServer()
      await server.start()
      const token = server.issueLoginToken(String(e.user_id))
      await e.reply([
        'New API 监控配置链接（5 分钟内有效，仅可使用一次）：',
        server.loginUrl(token),
      ].join('\n'))
    } catch (error) {
      globalThis.logger?.error?.('[NewAPI Monitor] Web 配置服务启动失败', error)
      await e.reply(`Web 配置服务启动失败：${error.message}`)
    }
    return true
  }
}
