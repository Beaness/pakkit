import dns from 'node:dns'

// Mirrors Minecraft's ServerAddress.parseString() + AddressResolver + RedirectResolver.
//
// Minecraft parses "host:port" (or just "host") using a URI, then if no custom
// port was given it queries the _minecraft._tcp.<host> SRV record and uses the
// host/port from that record instead. Bedrock does not do SRV lookups.
//
// See:
//   net.minecraft.client.multiplayer.resolver.ServerAddress
//   net.minecraft.client.multiplayer.resolver.AddressResolver
//   net.minecraft.client.multiplayer.resolver.RedirectResolver

const DEFAULT_PORTS = {
  java: 25565,
  bedrock: 19132
}

// Minecraft uses new URI(null, "//" + address, null). We use URL with an http
// scheme to get the same authority-component parsing (handles IPv6 brackets,
// host:port splitting, etc.).
function parseAddress (addressString, defaultPort) {
  try {
    const url = new URL(`http://${addressString}`)
    const host = url.hostname || addressString
    const port = url.port ? parseInt(url.port, 10) : defaultPort
    return { host, port }
  } catch (err) {
    return { host: addressString, port: defaultPort }
  }
}

// RedirectResolver only does SRV for hostnames, not IP literals.
function isIpAddress (host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true // IPv4
  if (host.includes(':')) return true // IPv6 (URL.hostname strips brackets)
  return false
}

export async function resolveServerAddress (addressString, platform) {
  const defaultPort = DEFAULT_PORTS[platform] ?? DEFAULT_PORTS.java

  const { host, port } = parseAddress(addressString, defaultPort)

  // Java Edition: SRV lookup only when using the default port (matches
  // RedirectResolver which skips SRV when a custom port is given).
  if (platform === 'java' && port === 25565 && !isIpAddress(host)) {
    try {
      const records = await dns.promises.resolveSrv(`_minecraft._tcp.${host}`)
      if (records.length > 0) {
        return { host: records[0].name, port: records[0].port }
      }
    } catch (err) {
      // No SRV record — fall through to parsed address
    }
  }

  return { host, port }
}
