import Peer, { DataConnection, MediaConnection } from "peerjs";

export type ReplyRef = { msgId: string; authorName: string; snippet: string };

export type WireMsg =
  | { type: "hello"; name: string; peerId: string }
  | { type: "text"; msgId: string; from: string; fromName: string; text: string; ts: number; toGroup?: string; replyTo?: ReplyRef }
  | { type: "image"; msgId: string; from: string; fromName: string; imageDataUrl: string; ts: number; toGroup?: string; replyTo?: ReplyRef }
  | { type: "members"; groupId: string; members: { peerId: string; name: string }[] }
  | { type: "music-open"; videoId: string; toGroup?: string; ts: number }
  | { type: "music-state"; playing: boolean; positionSec: number; ts: number; toGroup?: string }
  | { type: "music-close"; toGroup?: string; ts: number };

export type IncomingVoiceCall = {
  peerId: string;
  /** Accept the call. If a stream is provided, the other side will hear it. */
  accept: (myStream?: MediaStream) => void;
  /** Reject and close the call. */
  reject: () => void;
};

export type PeerEvents = {
  onReady: (myId: string) => void;
  onConnect: (peerId: string) => void;
  onDisconnect: (peerId: string) => void;
  onMessage: (fromPeerId: string, msg: WireMsg) => void;
  onError: (err: Error) => void;
  onRemoteStream: (fromPeerId: string, stream: MediaStream) => void;
  onRemoteStreamEnded: (fromPeerId: string) => void;
  onIncomingVoiceCall: (info: IncomingVoiceCall) => void;
  onRemoteVoice: (fromPeerId: string, stream: MediaStream) => void;
  onRemoteVoiceEnded: (fromPeerId: string) => void;
  onRemoteCamera: (fromPeerId: string, stream: MediaStream) => void;
  onRemoteCameraEnded: (fromPeerId: string) => void;
};

export class PeerManager {
  peer: Peer;
  myId: string = "";
  myName: string = "Yo";
  connections: Map<string, DataConnection> = new Map();
  private incomingCalls: Map<string, MediaConnection> = new Map();
  private outgoingCalls: Map<string, MediaConnection> = new Map();
  private localShareStream?: MediaStream;
  // Voice call state — separate from screen share so they can run independently
  private voiceStream?: MediaStream;
  private voiceCalls: Map<string, MediaConnection> = new Map();
  // Camera state — webcam shared during a voice call
  private cameraStream?: MediaStream;
  private cameraCalls: Map<string, MediaConnection> = new Map();
  private incomingCameraCalls: Map<string, MediaConnection> = new Map();
  private events: PeerEvents;
  private ready = false;
  private pendingConnects: { peerId: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  // Tracks connect attempts that started but haven't opened (or failed) yet,
  // so we don't spam duplicate PeerJS connections during auto-reconnect.
  private inFlight: Set<string> = new Set();

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
      const kindMeta = (call.metadata && (call.metadata as { kind?: string }).kind) || "screen";

      if (kindMeta === "voice") {
        // Notify app — user has to accept or reject. The call stays open until they decide.
        const accept = (myStream?: MediaStream) => {
          try {
            call.answer(myStream);
            this.voiceCalls.set(call.peer, call);
            call.on("stream", (remoteStream) => {
              this.events.onRemoteVoice(call.peer, remoteStream);
            });
            call.on("close", () => {
              this.voiceCalls.delete(call.peer);
              this.events.onRemoteVoiceEnded(call.peer);
            });
            call.on("error", (err) => {
              console.error("[peer] voice call error", err);
              this.voiceCalls.delete(call.peer);
              this.events.onRemoteVoiceEnded(call.peer);
            });
          } catch (e) {
            console.error("[peer] accept voice call failed", e);
          }
        };
        const reject = () => {
          try { call.close(); } catch { /* ignore */ }
        };
        this.events.onIncomingVoiceCall({ peerId: call.peer, accept, reject });
      } else if (kindMeta === "video") {
        // Auto-accept incoming camera streams from peers we're in a voice call with.
        if (this.voiceCalls.has(call.peer)) {
          call.answer();
          this.incomingCameraCalls.set(call.peer, call);
          call.on("stream", (remoteStream) => {
            this.events.onRemoteCamera(call.peer, remoteStream);
          });
          call.on("close", () => {
            this.incomingCameraCalls.delete(call.peer);
            this.events.onRemoteCameraEnded(call.peer);
          });
          call.on("error", (err) => {
            console.error("[peer] incoming camera call error", err);
            this.incomingCameraCalls.delete(call.peer);
            this.events.onRemoteCameraEnded(call.peer);
          });
        } else {
          // Not in a call → drop the video to avoid surprise webcam streams.
          try { call.close(); } catch { /* ignore */ }
        }
      } else {
        // Screen share: one-way watch (no outbound stream).
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
      }
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
    if (this.inFlight.has(peerId)) return;
    this.inFlight.add(peerId);
    const conn = this.peer.connect(peerId, { reliable: true });
    this.setupConnection(conn);
  }

  private setupConnection(conn: DataConnection) {
    conn.on("open", () => {
      this.inFlight.delete(conn.peer);
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
      this.inFlight.delete(conn.peer);
      this.connections.delete(conn.peer);
      this.events.onDisconnect(conn.peer);
    });
    conn.on("error", (err) => {
      this.inFlight.delete(conn.peer);
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

  /** True if currently connected OR in the middle of opening a connection. */
  isLinked(peerId: string): boolean {
    return this.isConnected(peerId) || this.inFlight.has(peerId);
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

  async startScreenShare(peerIds: string[], withAudio = true): Promise<MediaStream> {
    if (this.localShareStream) throw new Error("Ya estás compartiendo");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Let the browser pick native resolution; cap frameRate at 60.
      video: { frameRate: { ideal: 60, max: 60 } } as MediaTrackConstraints,
      // Ask for system/tab audio. The user can decline in the picker (audio capture
      // is only offered when sharing "Entire screen" or "Browser tab" on most platforms).
      audio: withAudio,
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

  // ===== Voice (mic) calls =====

  /** Ensure our mic is captured. Returns the stream so callers can pass it to call.answer(). */
  async ensureVoiceStream(): Promise<MediaStream> {
    if (this.voiceStream) return this.voiceStream;
    this.voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    return this.voiceStream;
  }

  async startVoice(peerIds: string[]): Promise<void> {
    await this.ensureVoiceStream();
    for (const pid of peerIds) {
      this.placeVoiceCall(pid);
    }
  }

  /** Add a peer to the active voice call (e.g. when they connect mid-call). */
  placeVoiceCall(peerId: string) {
    if (!this.voiceStream) return;
    if (this.voiceCalls.has(peerId)) return;
    try {
      const call = this.peer.call(peerId, this.voiceStream, { metadata: { kind: "voice" } });
      this.voiceCalls.set(peerId, call);
      call.on("stream", (remoteStream) => {
        this.events.onRemoteVoice(peerId, remoteStream);
      });
      call.on("close", () => {
        this.voiceCalls.delete(peerId);
        this.events.onRemoteVoiceEnded(peerId);
      });
      call.on("error", (e) => {
        console.error("[peer] outgoing voice call error", e);
        this.voiceCalls.delete(peerId);
      });
    } catch (e) {
      console.error(`[peer] failed to place voice call to ${peerId}`, e);
    }
  }

  stopVoice() {
    this.stopCamera();  // camera depends on a voice call being active
    for (const call of this.voiceCalls.values()) {
      try { call.close(); } catch { /* ignore */ }
    }
    this.voiceCalls.clear();
    if (this.voiceStream) {
      for (const t of this.voiceStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this.voiceStream = undefined;
    }
  }

  // ===== Camera (during voice call) =====

  async startCamera(peerIds: string[]): Promise<MediaStream> {
    if (this.cameraStream) return this.cameraStream;
    this.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } as MediaTrackConstraints,
      audio: false,
    });
    // Auto-stop everything if the camera track ends (user revokes, device disconnect)
    const track = this.cameraStream.getVideoTracks()[0];
    if (track) track.addEventListener("ended", () => this.stopCamera());
    for (const pid of peerIds) {
      this.placeCameraCall(pid);
    }
    return this.cameraStream;
  }

  placeCameraCall(peerId: string) {
    if (!this.cameraStream) return;
    if (this.cameraCalls.has(peerId)) return;
    try {
      const call = this.peer.call(peerId, this.cameraStream, { metadata: { kind: "video" } });
      this.cameraCalls.set(peerId, call);
      call.on("close", () => this.cameraCalls.delete(peerId));
      call.on("error", (e) => {
        console.error("[peer] outgoing camera call error", e);
        this.cameraCalls.delete(peerId);
      });
    } catch (e) {
      console.error(`[peer] failed to place camera call to ${peerId}`, e);
    }
  }

  stopCamera() {
    for (const call of this.cameraCalls.values()) {
      try { call.close(); } catch { /* ignore */ }
    }
    this.cameraCalls.clear();
    if (this.cameraStream) {
      for (const t of this.cameraStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this.cameraStream = undefined;
    }
  }

  getLocalCameraStream(): MediaStream | undefined {
    return this.cameraStream;
  }

  isCameraActive(): boolean {
    return !!this.cameraStream;
  }

  isVoiceActive(): boolean {
    return !!this.voiceStream;
  }

  setMicMuted(muted: boolean) {
    if (!this.voiceStream) return;
    for (const t of this.voiceStream.getAudioTracks()) {
      t.enabled = !muted;
    }
  }

  destroy() {
    this.stopScreenShare();
    this.stopVoice();
    this.stopCamera();
    try { this.peer.destroy(); } catch { /* ignore */ }
  }
}
