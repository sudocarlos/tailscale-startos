import * as net from 'net'

export interface TcpProxy {
  localPort: number
  close: () => Promise<void>
}

/**
 * Creates a TCP proxy forwarding 127.0.0.1:<localPort> -> remoteHost:remotePort.
 *
 * Used so that `tailscale serve --tcp=<port> tcp://localhost:<port>` can reach
 * services on the StartOS internal network (e.g. home-assistant.startos:8123).
 */
export function createTcpProxy(
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<TcpProxy> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const remote = net.createConnection(
        { host: remoteHost, port: remotePort },
        () => {
          client.pipe(remote)
          remote.pipe(client)
        },
      )
      remote.on('error', (err) => {
        console.error(
          `[tcp-proxy] ${remoteHost}:${remotePort}: ${err.message}`,
        )
        client.destroy()
      })
      client.on('error', () => remote.destroy())
      client.on('close', () => remote.destroy())
      remote.on('close', () => client.destroy())
    })

    server.on('error', reject)

    server.listen(localPort, '127.0.0.1', () => {
      console.info(
        `[tcp-proxy] 127.0.0.1:${localPort} -> ${remoteHost}:${remotePort}`,
      )
      resolve({
        localPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

/** Global registry of running proxies keyed by "packageId/interfaceId" */
const proxies = new Map<string, TcpProxy>()

export function proxyKey(packageId: string, interfaceId: string): string {
  return `${packageId}/${interfaceId}`
}

export async function startProxy(
  key: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<void> {
  if (proxies.has(key)) return
  const proxy = await createTcpProxy(localPort, remoteHost, remotePort)
  proxies.set(key, proxy)
}

export async function stopProxy(key: string): Promise<void> {
  const proxy = proxies.get(key)
  if (proxy) {
    await proxy.close()
    proxies.delete(key)
    console.info(`[tcp-proxy] Stopped proxy ${key} on port ${proxy.localPort}`)
  }
}

export async function stopAllProxies(): Promise<void> {
  for (const [key] of proxies) {
    await stopProxy(key)
  }
}
