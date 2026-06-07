/**
 * @karyl-chan/voice — public surface.
 *
 * The standalone voice service: the gateway bridge (PR-2.3b) plus, in a
 * follow-up segment, the relocated framework-free voice manager (PR-2.3c)
 * and HTTP server (PR-2.3c).
 */
export {
  GatewayBridge,
  type GatewayBridgeTransport,
  type GatewayEventType,
} from "./gateway-bridge.js";
