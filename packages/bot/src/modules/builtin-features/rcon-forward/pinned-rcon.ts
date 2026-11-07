import { createConnection } from "net";
import Rcon from "rcon";
import {
  pinnedLookup,
  type PinnedAddress,
} from "../../../utils/pinned-dispatcher.js";

/**
 * An RCON client whose socket connects only to the addresses the host
 * policy vetted (`resolveAllowedTarget`), so a DNS answer that changes
 * after the check (DNS rebinding) cannot redirect it.
 *
 * The client keeps the hostname; the socket's `lookup` answers with the
 * pinned addresses instead of asking DNS — the same pinning the behavior
 * webhooks use (`pinned-dispatcher`). Node still gets every vetted
 * address, so an unreachable first answer falls back to the next one, as
 * a plain hostname connect would. RCON is plain TCP: no TLS, SNI or Host
 * header depends on the name.
 */
export class PinnedRcon extends Rcon {
  private readonly pinned: readonly PinnedAddress[];

  constructor(
    host: string,
    port: number,
    password: string,
    pinned: readonly PinnedAddress[],
  ) {
    super(host, port, password);
    this.pinned = pinned;
  }

  /**
   * node-rcon 1.1.0's TCP `connect()` with the socket's lookup pinned;
   * tests/pinned-rcon.test.ts runs it against the real client. TCP only:
   * the UDP mode node-rcon offers is never used here.
   */
  override async connect(): Promise<void> {
    const socket = createConnection({
      host: this.host,
      port: this.port,
      lookup: pinnedLookup(this.pinned),
    });
    this._tcpSocket = socket;
    socket
      .on("data", (data: Buffer) => this._tcpSocketOnData(data))
      .on("connect", () => this.socketOnConnect())
      .on("error", (err: Error) => this.emit("error", err))
      .on("end", () => this.socketOnEnd());
  }
}
