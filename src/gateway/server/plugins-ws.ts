import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type PluginWsUpgradeHandlerFn = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => boolean;

/**
 * Creates a composed WS upgrade handler that iterates registered plugin handlers.
 * Returns null when there are no registered handlers (avoids unnecessary allocation).
 */
export function createGatewayPluginWsUpgradeHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginWsUpgradeHandlerFn | null {
  const { registry, log } = params;
  if (!registry.wsUpgradeHandlers || registry.wsUpgradeHandlers.length === 0) {
    return null;
  }
  return (req, socket, head) => {
    for (const entry of registry.wsUpgradeHandlers) {
      try {
        if (entry.handler(req, socket, head)) {
          return true;
        }
      } catch (err) {
        log.warn(`[plugin ws upgrade] error (${entry.pluginId ?? "unknown"}): ${String(err)}`);
        socket.destroy();
        return true;
      }
    }
    return false;
  };
}
