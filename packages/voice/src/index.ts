/**
 * @karyl-chan/voice — public surface.
 *
 * The standalone voice service: the gateway bridge (PR-2.3b), the relocated
 * framework-free voice manager (PR-2.3c), and the HTTP server (PR-2.3c). The
 * bot's InProcessVoiceBackend imports the manager from here so single-machine
 * and split deployments share one implementation.
 */
export {
  GatewayBridge,
  type GatewayBridgeTransport,
  type GatewayEventType,
} from "./gateway-bridge.js";

export {
  joinVoice,
  leaveVoice,
  playUrl,
  pausePlayback,
  stopPlayback,
  getStatus,
  shutdownAllVoice,
  setVoiceLogger,
  VoiceCapacityError,
  type VoiceStatus,
  type JoinOptions,
  type VoiceLogger,
} from "./voice-manager.js";
