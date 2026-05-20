import Peer, { DataConnection, MediaConnection } from "peerjs";

export type WireMsg =
  | { type: "hello"; name: string; peerId: string }
  | { type: "text"; msgId: string; from: string; fromName: string; text: string; ts: number; toGroup?: string }
  | { type: "image"; msgId: string; from: string; fromName: string; imageDataUrl: string; ts: number; toGroup?: string }
  | { type: "members"; groupId: string; members: { peerId: string; name: string }[] };

export type PeerEvents = {
  onReady: (myId: string) => void;
  onConnect: (peerId: string) => void;
  onDisconnect: (peerId: string) => void;
  onMessage: (fromPeerId: string, msg: WireMsg) => void;
  onError: (err: Error) => void;
  onRemoteStream: (fromPeerId: string, stream: MediaStream) => void;
  onRemoteStreamEnded: (fromPeerId: string) => void;
};

export class PeerManager {
  peer: Peer;
  myId: string = "";
  myName: string = "Yo";
  connections: Map<string, DataConnection> = new Map();
  private incomingCalls: Map<string, MediaConnection> = new Map();
  private outgoingCalls: Map<string, MediaConnection> = new Map();
  private localShareStream?: MediaStream;
  private events: PeerEvents;
  private ready = false;
  private pendingConnects: { peerId: string; resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(savedId: string | undefined, name: string, events: PeerEvents) {
    this.myName = name;
    this.events = events;
    this.peer = savedId ? new Peer(savedId) : new Peer();

    this.peer.on("open", (id) => {
      this.myId = id;
      this.ready = true;
      events.onReady(id);
      for (const p of this.pendingConnects) {
        try {
          this.doConnect(p.peerId);
          p.resolve();
        } catch (e) {
          p.reject(e as Error);
        }
      }
      this.pendingConnects = [];
    });

    this.peer.on("connection", (conn) => this.setupConnection(conn));

    this.peer.on("call", (call) => {
      // Auto-answer incoming screen share with no outbound stream (one-way watch)
      call.answer();
      this.incomingCalls.set(call.peer, call);
      call.on("stream", (remoteStream) => {
        this.events.onRemoteStream(call.peer, remoteStream);
      });
      call.on("close", () => {
        this.incomingCalls.delete(call.peer);
        this.events.onRemoteStreamEnded(call.peer);
      });
      call.on("error", (err) => {
        console.error("[peer] incoming call error", err);
        this.incomingCalls.delete(call.peer);
        this.events.onRemoteStreamEnded(call.peer);
      });
    });

    this.peer.on("error", (err) => {
      console.error("[peer] error", err);
      events.onError(err as Error);
    });

    this.peer.on("disconnected", () => {
      setTimeout(() => {
        if (!this.peer.destroyed) this.peer.reconnect();
      }, 1500);
    });
  }

  setName(name: string) {
    this.myName = name;
    for (const conn of this.connections.values()) {
      this.sendOver(conn, { type: "hello", name, peerId: this.myId });
    }
  }

  connect(peerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        this.pendingConnects.push({ peerId, resolve, reject });
        return;
      }
      try {
        this.doConnect(peerId);
        resolve();
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  private doConnect(peerId: string) {
    if (peerId === this.myId) throw new Error("No te puedes conectar a ti mismo");
    if (this.connections.has(peerId)) return;
    const conn = this.peer.connect(peerId, { reliable: true });
    this.setupConnection(conn);
  }

  private setupConnection(conn: DataConnection) {
    conn.on("open", () => {
      this.connections.set(conn.peer, conn);
      this.sendOver(conn, { type: "hello", name: this.myName, peerId: this.myId });
      this.events.onConnect(conn.peer);
    });
    conn.on("data", (data) => {
      try {
        this.events.onMessage(conn.peer, data as WireMsg);
      } catch (e) {
        console.error("[peer] onMessage error", e);
      }
    });
    conn.on("close", () => {
      this.connections.delete(conn.peer);
      this.events.onDisconnect(conn.peer);
    });
    conn.on("error", (err) => {
      console.error("[peer] conn error", err);
    });
  }

  send(peerId: string, msg: WireMsg): boolean {
    const conn = this.connections.get(peerId);
    if (!conn || !conn.open) return false;
    return this.sendOver(conn, msg);
  }

  broadcast(msg: WireMsg, exceptPeerId?: string) {
    for (const [pid, conn] of this.connections) {
      if (pid === exceptPeerId) continue;
      this.sendOver(conn, msg);
    }
  }

  private sendOver(conn: DataConnection, msg: WireMsg): boolean {
    try {
      conn.send(msg);
      return true;
    } catch (e) {
      console.error("[peer] send error", e);
      return false;
    }
  }

  isConnected(peerId: string): boolean {
    const c = this.connections.get(peerId);
    return !!c && c.open;
  }

  disconnect(peerId: string) {
    const c = this.connections.get(peerId);
    if (c) {
      try { c.close(); } catch { /* ignore */ }
      this.connections.delete(peerId);
    }
    const oc = this.outgoingCalls.get(peerId);
    if (oc) {
      try { oc.close(); } catch { /* ignore */ }
      this.outgoingCalls.delete(peerId);
    }
    const ic = this.incomingCalls.get(peerId);
    if (ic) {
      try { ic.close(); } catch { /* ignore */ }
      this.incomingCalls.delete(peerId);
    }
  }

  // ===== Screen share =====

  async startScreenShare(peerIds: string[]): Promise<MediaStream> {
    if (this.localShareStream) throw new Error("Ya estás compartiendo");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Let the browser pick native resolution; cap frameRate at 60 (will pick whatever your monitor supports).
      video: { frameRate: { ideal: 60, max: 60 } } as MediaTrackConstraints,
      audio: false,
    });
    this.localShareStream = stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener("ended", () => this.stopScreenShare());
    }

    for (const peerId of peerIds) {
      try {
        const call = this.peer.call(peerId, stream);
        this.outgoingCalls.set(peerId, call);
        // Bump the encoder bitrate ceiling so the receiver gets a sharp image
        // (default ~1-2 Mbps; we want 6 Mbps for clear HD screen share).
        this.boostCallBitrate(call);
        call.on("close", () => this.outgoingCalls.delete(peerId));
        call.on("error", (e) => {
          console.error("[peer] outgoing call error", e);
          this.outgoingCalls.delete(peerId);
        });
      } catch (e) {
        console.error(`[peer] failed to call ${peerId}`, e);
      }
    }

    return stream;
  }

  private boostCallBitrate(call: MediaConnection) {
    // Give the underlying RTCPeerConnection a moment to finish negotiation.
    const attempt = () => {
      try {
        const pc = (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
        if (!pc) return false;
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (!sender) return false;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 6_000_000;
        params.encodings[0].maxFramerate = 60;
        sender.setParameters(params).catch((e) => console.warn("[peer] setParameters", e));
        return true;
      } catch (e) {
        console.warn("[peer] boostCallBitrate failed", e);
        return false;
      }
    };
    // Try a few times in case the senders aren't ready immediately
    setTimeout(() => attempt() || setTimeout(() => attempt() || setTimeout(attempt, 2000), 1000), 500);
  }

  stopScreenShare() {
    for (const call of this.outgoingCalls.values()) {
      try { call.close(); } catch { /* ignore */ }
    }
    this.outgoingCalls.clear();
    if (this.localShareStream) {
      for (const t of this.localShareStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this.localShareStream = undefined;
    }
  }

  isSharing(): boolean {
    return !!this.localShareStream;
  }

  destroy() {
    this.stopScreenShare();
    try { this.peer.destroy(); } catch { /* ignore */ }
  }
}
