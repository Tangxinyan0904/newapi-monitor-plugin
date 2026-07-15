import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfigStore } from './config.js'
import { createStateStore } from './stateStore.js'
import { createNewApiClient } from './newApiClient.js'
import { createMonitorEngine } from './monitorEngine.js'
import { notifyOwners } from './notifier.js'
import { AdminServer } from './adminServer.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const configStore = createConfigStore({ pluginRoot })
const initialConfig = configStore.load()
const stateStore = createStateStore(path.join(pluginRoot, 'data/state.json'))
const client = createNewApiClient({ timeoutMs: initialConfig.monitor.timeoutMs })
const engine = createMonitorEngine({
  configStore,
  stateStore,
  client,
  notify: notifyOwners,
})
let adminServer = null

const runtimeSingleton = {
  pluginRoot,
  configStore,
  stateStore,
  client,
  engine,
}

export function getRuntime() {
  return runtimeSingleton
}

export function refreshRuntimeConfig() {
  return runtimeSingleton.configStore.load()
}

export function getAdminServer() {
  adminServer ||= new AdminServer({
    configStore,
    stateStore,
    client,
    engine,
    resourcesDir: path.join(pluginRoot, 'resources/admin'),
  })
  return adminServer
}
