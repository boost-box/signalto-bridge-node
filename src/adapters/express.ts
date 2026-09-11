/**
 * adapters/express.ts — the Express/Connect mount (plan §8). Thin by design:
 * the canonical node handler IS valid Express 4/5 middleware; this module
 * only pairs it with bridge construction for the one-line mount:
 *
 *   import { signaltoBridge } from '@signalto/bridge-node/express';
 *   app.use(signaltoBridge());   // FIRST — before routes and other middleware
 *
 * Mount order is load-bearing (plan L-N6): mounted late, the connector never
 * sees /robots.txt and the pairing probe honestly reports the op-types
 * unavailable — nothing breaks, but nothing is managed either.
 */
import { createBridge, SignalToBridge, type BridgeOptions } from '../index.js';
import { createNodeHandler, type NodeHandler } from '../handlers/node.js';

export interface ExpressBridge extends NodeHandler {
  /** The underlying bridge — health inspection and tests. */
  readonly bridge: SignalToBridge;
}

export function signaltoBridge(options: BridgeOptions = {}): ExpressBridge {
  const bridge = createBridge(options);
  const handler = createNodeHandler(bridge) as ExpressBridge;
  Object.defineProperty(handler, 'bridge', { value: bridge, enumerable: false });
  return handler;
}

export { createBridge, SignalToBridge };
export type { BridgeOptions, NodeHandler };
