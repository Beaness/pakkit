export async function stopSessionAndLoadStart ({ activeProxy, disposePacketHandlers, loadStartPage }) {
  disposePacketHandlers()

  let stopError
  try {
    activeProxy?.end()
  } catch (error) {
    stopError = error
  }

  await loadStartPage()
  return stopError
}
