/**
 * dsh-wsl-launcher / client — browser presence for optional Web autostop.
 * @module dsh-wsl-launcher/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-wsl-launcher',
  factory: () => ({
    apply() {
      const statusPath = '/api/autostop/status'
      const presencePath = '/api/autostop/presence'
      const byePath = '/api/autostop/bye'
      const heartbeatMs = 5_000
      const clientIdKey = 'dsh-wsl-launcher-client'
      let clientId
      try {
        clientId = window.sessionStorage.getItem(clientIdKey)
        if (!clientId) {
          clientId = Math.random().toString(36).slice(2) + Date.now().toString(36)
          window.sessionStorage.setItem(clientIdKey, clientId)
        }
      } catch {
        clientId = 'no-storage'
      }
      let timer = null
      const beat = () => {
        void fetch(presencePath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId }),
          keepalive: true,
        }).catch(() => {})
      }
      const stop = () => {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
      const start = () => {
        beat()
        stop()
        timer = setInterval(beat, heartbeatMs)
      }
      void fetch(statusPath).then(response => {
        if (response.ok) start()
        else stop()
      }).catch(stop)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') beat()
      })
      window.addEventListener('pagehide', () => {
        void fetch(byePath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId }),
          keepalive: true,
        }).catch(() => {})
      })
    },
  }),
})
