/**
 * ip-address — re-export of the shared address classification.
 *
 * The implementation moved to `@karyl-chan/voice/net` (#158) so the bot's
 * host policies and the voice media proxy classify addresses with one
 * definition. That subpath is side-effect free (unlike the package root),
 * so config.ts can still reach this through webhook-allowlist without
 * pulling in the voice manager or the logger.
 */
export {
  addressBytes,
  classifyAddress,
  classifyBytes,
  KNOWN_METADATA_ADDRESSES,
  normalizeIpLiteral,
  parseIPv4Bytes,
  parseIPv6Bytes,
  transitionEmbeddedIPv4,
  type AddressClass,
} from "@karyl-chan/voice/net";
