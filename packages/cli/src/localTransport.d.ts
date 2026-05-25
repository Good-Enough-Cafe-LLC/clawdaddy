export interface LocalTransportOptions {
    hostId: string;
    onConnect: () => void;
    onClose: () => void;
    log: (msg: string, type?: string) => void;
}
export declare function createLocalTransport(options: LocalTransportOptions): {
    send: (packet: any) => void;
    disconnect: () => void;
    socketPath: string;
};
