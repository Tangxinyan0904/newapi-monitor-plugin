import fs from 'node:fs'
import path from 'node:path'

function emptyState() {
  return { sites: {} }
}

export function createStateStore(file = path.resolve('data/newapi-monitor/state.json')) {
  return {
    load() {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!data?.sites || typeof data.sites !== 'object' || Array.isArray(data.sites)) {
          return emptyState()
        }
        return { sites: data.sites }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          globalThis.logger?.warn?.(`[NewAPI Monitor] State read failed: ${error.message}`)
        }
        return emptyState()
      }
    },

    save(state) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ sites: state?.sites || {} }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      })
      fs.renameSync(temp, file)
    },
  }
}
