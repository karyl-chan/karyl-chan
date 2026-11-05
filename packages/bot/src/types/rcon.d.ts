declare module 'rcon' {
    export default class Rcon {
        constructor(host: string, port: number, password: string);
        host: string;
        port: number;
        connect(): Promise<void>;
        disconnect(): void;
        send(command: string): void;
        on(event: 'auth', callback: () => void): this;
        on(event: 'response', callback: (str: string) => void): this;
        on(event: 'server', callback: (str: string) => void): this;
        on(event: 'error', callback: (err: Error) => void): this;
        on(event: 'end', callback: () => void): this;
        removeAllListeners(): void;
        emit(event: string, ...args: unknown[]): boolean;
        // node-rcon 1.1.0 internals that PinnedRcon's connect() reuses.
        protected _tcpSocket?: import('net').Socket;
        protected _tcpSocketOnData(data: Buffer): void;
        protected socketOnConnect(): void;
        protected socketOnEnd(): void;
    }
}
