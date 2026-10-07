# minecraft-data overlay

Protocol data for Minecraft versions that the published `minecraft-data` npm
package does not include yet. `src/minecraftDataOverlay.mjs` copies these
files into the downloaded package at startup, but only for versions the
package doesn't already ship, so this folder can be deleted once upstream
releases them.

| Version | Files | Source |
| --- | --- | --- |
| 26.2 (protocol 776) | `protocol.json`, `version.json` | [PrismarineJS/minecraft-data#1301](https://github.com/PrismarineJS/minecraft-data/pull/1301) (`924e26d6`), which includes #1298 |
| 26.2 | `loginPacket.json` | [PrismarineJS/minecraft-data#1322](https://github.com/PrismarineJS/minecraft-data/pull/1322) (`69869abf`) |
| 26.3 (protocol 777) | `protocol.json`, `version.json` | [PrismarineJS/minecraft-data#1301](https://github.com/PrismarineJS/minecraft-data/pull/1301) |

Registries (blocks, items, etc.) fall back to the newest release, which is all
pakkit needs to bridge and display packets.
