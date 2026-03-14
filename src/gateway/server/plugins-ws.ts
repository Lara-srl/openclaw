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
 * Checks the registry at invocation time so plugins registered after gateway start are included.
 */
export function createGatewayPluginWsUpgradeHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginWsUpgradeHandlerFn {
  const { registry, log } = params;
  return (req, socket, head) => {
    const handlers = registry.wsUpgradeHandlers ?? [];
    if (handlers.length === 0) {
      return false;
    }
    for (const entry of handlers) {
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
