import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { PeerManager, WireMsg } from "./peer";

type RoomKind = "dm" | "group";

type Msg = {
  id: string;
  author: "me" | string;        // "me" or peer ID
  authorName?: string;
  text?: string;
  imageDataUrl?: string;
  ts: number;
};

type Room = {
  id: string;
  kind: RoomKind;
  name: string;
  hostPeerId: string;
  isHost: boolean;
  memberPeerIds: string[];
  memberNames: Record<string, string>;
  mineColor: string;
  theirsColor: string;
  mineOpacity?: number;        // 0..1, defaults to 1
  theirsOpacity?: number;
  messages: Msg[];
};

type AppSettings = {
  myName: string;
  myPeerId?: string;
  opacity: number;
  fontColor: string;
  fontSize: number;
  bgTint: string;
  contentProtected: boolean;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  skipTaskbar: boolean;
  notifSound: boolean;
};

const DEFAULT_MINE = "#3a3d4a";
const DEFAULT_THEIRS = "#23252e";

const DEFAULT_SETTINGS: AppSettings = {
  myName: "",
  opacity: 0.9,
  fontColor: "#e7ecf3",
  fontSize: 14,
  bgTint: "#0f1117",
  contentProtected: true,
  alwaysOnTop: true,
  clickThrough: false,
  skipTaskbar: true,
  notifSound: true,
};

// Subtle generated chime — no asset needed. Two short pure tones, total ~280ms.
function playNotifSound() {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    const beep = (start: number, freq: number, dur: number, peak = 0.08) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain).connect(ctx.destination);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    };
    beep(now, 880, 0.12);
    beep(now + 0.13, 1175, 0.16);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch (e) {
    console.warn("[notif] sound failed", e);
  }
}

const LS_ROOMS = "sc.rooms";
const LS_SETTINGS = "sc.settings";
const LS_ACTIVE = "sc.activeId";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function loadRooms(): Room[] {
  try {
    const raw = localStorage.getItem(LS_ROOMS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Room[];
    return parsed.map((r) => ({ ...r, messages: [] }));
  } catch {
    return [];
  }
}

function saveRooms(rooms: Room[]) {
  const stripped = rooms.map(({ messages: _m, ...r }) => ({ ...r, messages: [] }));
  localStorage.setItem(LS_ROOMS, JSON.stringify(stripped));
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    const parsed = raw ? (JSON.parse(raw) as Partial<AppSettings>) : {};
    // Always boot with click-through OFF so the user can never be locked out.
    return { ...DEFAULT_SETTINGS, ...parsed, clickThrough: false };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

export default function App() {
  const [rooms, setRooms] = useState<Room[]>(() => loadRooms());
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem(LS_ACTIVE) ?? "");
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [myPeerId, setMyPeerId] = useState<string>("");
  const [peerReady, setPeerReady] = useState(false);
  const [toast, setToast] = useState<string>("");
  const [nameSetupOpen, setNameSetupOpen] = useState<boolean>(() => !loadSettings().myName);
  const [isSharing, setIsSharing] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem("sc.splitRatio") ?? "");
    return Number.isFinite(v) && v >= 0.25 && v <= 0.9 ? v : 0.65;
  });
  const [draggingSplit, setDraggingSplit] = useState(false);
  // Map of peerId -> display name for peers who connected but we don't know yet.
  const [incomingRequests, setIncomingRequests] = useState<Map<string, string>>(new Map());
  // Peers whose screen share we've dismissed locally (we just hide it; the sender keeps sharing).
  const [hiddenStreamPeerIds, setHiddenStreamPeerIds] = useState<Set<string>>(new Set());
  // Which remote stream is currently in immersive (overlay) mode — takes over the entire window.
  const [immersivePeerId, setImmersivePeerId] = useState<string | null>(null);
  // Whether the floating chat mini-panel is visible while in immersive mode.
  const [immersiveChatOpen, setImmersiveChatOpen] = useState(false);
  // Image being viewed full-window in a lightbox (data URL), or null.
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body?: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total?: number } | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [checkStatus, setCheckStatus] = useState<"idle" | "checking" | "uptodate" | "found" | "error">("idle");

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const peerRef = useRef<PeerManager | null>(null);

  // Keep latest in refs for stable handlers
  const settingsRef = useRef(settings);
  const roomsRef = useRef(rooms);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);

  const activeRoom = useMemo(() => rooms.find((r) => r.id === activeId) ?? null, [rooms, activeId]);

  useEffect(() => saveRooms(rooms), [rooms]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
  }, [activeId]);

  // CSS vars
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--app-opacity", String(settings.opacity));
    root.style.setProperty("--font-color", settings.fontColor);
    root.style.setProperty("--font-size", `${settings.fontSize}px`);
    root.style.setProperty("--bg-tint", settings.bgTint);
    if (activeRoom) {
      root.style.setProperty("--mine", activeRoom.mineColor);
      root.style.setProperty("--theirs", activeRoom.theirsColor);
      root.style.setProperty("--mine-opacity", String(activeRoom.mineOpacity ?? 1));
      root.style.setProperty("--theirs-opacity", String(activeRoom.theirsOpacity ?? 1));
    }
  }, [settings, activeRoom]);

  // Stealth flags
  useEffect(() => { invoke("set_content_protected", { protected: settings.contentProtected }).catch(() => {}); }, [settings.contentProtected]);
  useEffect(() => { invoke("set_always_on_top", { enabled: settings.alwaysOnTop }).catch(() => {}); }, [settings.alwaysOnTop]);
  useEffect(() => { invoke("set_skip_taskbar", { skip: settings.skipTaskbar }).catch(() => {}); }, [settings.skipTaskbar]);
  useEffect(() => { invoke("set_click_through", { enabled: settings.clickThrough }).catch(() => {}); }, [settings.clickThrough]);

  // Scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeRoom?.messages.length, activeId]);

  const [focused, setFocused] = useState(true);
  const focusedRef = useRef(true);
  useEffect(() => { focusedRef.current = focused; }, [focused]);
  useEffect(() => {
    const unlistenF = listen<boolean>("window-focus", (e) => setFocused(e.payload));
    const unlistenC = listen("click-through-disabled", () => {
      setSettings((s) => ({ ...s, clickThrough: false }));
      showToast("Click-a-través apagado");
    });
    return () => {
      unlistenF.then((u) => u());
      unlistenC.then((u) => u());
    };
  }, []);

  // Make the OS window fullscreen while in immersive mode so the video fills the whole monitor
  // (otherwise the shared screen is limited to whatever size the Chati window has).
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    if (immersivePeerId) {
      win.setFullscreen(true).catch((e) => console.warn("[fullscreen] enter failed", e));
    } else {
      win.setFullscreen(false).catch((e) => console.warn("[fullscreen] exit failed", e));
    }
  }, [immersivePeerId]);

  // Keyboard shortcuts for immersive mode:
  // - Ctrl+Shift+M  → toggle immersive on the first remote stream in the active room
  // - Escape        → exit immersive
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Lightbox takes priority — if open, close it first.
        if (lightboxImage) {
          e.preventDefault();
          setLightboxImage(null);
          return;
        }
        if (immersivePeerId) {
          e.preventDefault();
          setImmersivePeerId(null);
          return;
        }
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        if (immersivePeerId) {
          setImmersivePeerId(null);
          return;
        }
        // Pick the first visible remote stream from the active room
        const room = roomsRef.current.find((r) => r.id === activeId);
        if (!room) return;
        const candidate = room.memberPeerIds.find(
          (pid) => remoteStreams.has(pid) && !hiddenStreamPeerIds.has(pid),
        );
        if (candidate) setImmersivePeerId(candidate);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersivePeerId, activeId, remoteStreams, hiddenStreamPeerIds, lightboxImage]);

  // Split-view divider drag
  useEffect(() => {
    if (!draggingSplit) return;
    function onMove(e: MouseEvent) {
      const r = e.clientX / window.innerWidth;
      const clamped = Math.max(0.25, Math.min(0.9, r));
      setSplitRatio(clamped);
    }
    function onUp() {
      setDraggingSplit(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draggingSplit]);

  // Persist split ratio
  useEffect(() => {
    localStorage.setItem("sc.splitRatio", String(splitRatio));
  }, [splitRatio]);

  // Get app version (for display in settings)
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Check for updates on startup
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (cancelled) return;
        if (update) {
          setUpdateAvailable({ version: update.version, body: update.body });
        }
      } catch (e) {
        // Silent fail — likely no network or no endpoint configured yet
        console.warn("[updater] check failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function manualCheck() {
    setCheckStatus("checking");
    try {
      const update = await check();
      if (update) {
        setUpdateAvailable({ version: update.version, body: update.body });
        setCheckStatus("found");
      } else {
        setCheckStatus("uptodate");
        setTimeout(() => setCheckStatus((s) => (s === "uptodate" ? "idle" : s)), 4000);
      }
    } catch (e) {
      console.error("[updater] manual check failed", e);
      setCheckStatus("error");
      setTimeout(() => setCheckStatus((s) => (s === "error" ? "idle" : s)), 4000);
    }
  }

  async function installUpdate() {
    setUpdating(true);
    try {
      const update = await check();
      if (!update) {
        showToast("Ya estás en la última versión");
        setUpdating(false);
        setUpdateAvailable(null);
        return;
      }
      let downloaded = 0;
      let total: number | undefined;
      await update.downloadAndInstall((progress) => {
        if (progress.event === "Started") {
          total = progress.data.contentLength;
        } else if (progress.event === "Progress") {
          downloaded += progress.data.chunkLength;
          setUpdateProgress({ downloaded, total });
        }
      });
      // After install, relaunch the app
      await relaunch();
    } catch (e: any) {
      console.error("[updater] install failed", e);
      showToast(`Error al actualizar: ${e?.message ?? "desconocido"}`);
      setUpdating(false);
    }
  }

  // Stable updateRoom helper
  const updateRoom = useCallback((id: string, fn: (r: Room) => Room) => {
    setRooms((rs) => rs.map((r) => (r.id === id ? fn(r) : r)));
  }, []);

  function showToast(text: string, duration = 2500) {
    setToast(text);
    setTimeout(() => setToast(""), duration);
  }

  // ===== PeerJS setup =====
  useEffect(() => {
    if (!settings.myName) return;  // wait for name
    if (peerRef.current) return;

    const handleIncoming = (fromPeerId: string, msg: WireMsg) => {
      if (msg.type === "hello") {
        // Update name in any room containing this peer
        setRooms((rs) =>
          rs.map((r) => {
            if (r.memberPeerIds.includes(fromPeerId)) {
              return { ...r, memberNames: { ...r.memberNames, [fromPeerId]: msg.name } };
            }
            return r;
          }),
        );
        // If we don't know this peer at all, queue them as an incoming request.
        const known = roomsRef.current.some((r) => r.memberPeerIds.includes(fromPeerId));
        if (!known) {
          setIncomingRequests((reqs) => {
            if (reqs.has(fromPeerId)) {
              // Update name if it changed
              if (reqs.get(fromPeerId) !== msg.name) {
                const next = new Map(reqs);
                next.set(fromPeerId, msg.name);
                return next;
              }
              return reqs;
            }
            const next = new Map(reqs);
            next.set(fromPeerId, msg.name);
            showToast(`${msg.name} quiere chatear contigo`, 4000);
            return next;
          });
        }
        return;
      }

      if (msg.type === "members") {
        // Host telling us the membership; create/update group room
        setRooms((rs) => {
          const existing = rs.find((r) => r.id === msg.groupId);
          if (existing) {
            const otherMembers = msg.members.filter((m) => m.peerId !== peerRef.current?.myId);
            return rs.map((r) =>
              r.id === msg.groupId
                ? {
                    ...r,
                    memberPeerIds: otherMembers.map((m) => m.peerId),
                    memberNames: Object.fromEntries(otherMembers.map((m) => [m.peerId, m.name])),
                  }
                : r,
            );
          }
          return rs;
        });
        // Connect to all other members of the group
        const myId = peerRef.current?.myId;
        for (const m of msg.members) {
          if (m.peerId !== myId && !peerRef.current?.isConnected(m.peerId)) {
            peerRef.current?.connect(m.peerId).catch(() => {});
          }
        }
        return;
      }

      if (msg.type === "text" || msg.type === "image") {
        // Route to room: group msg goes to msg.toGroup, DM goes to room with that peer
        const targetRoom = msg.toGroup
          ? roomsRef.current.find((r) => r.id === msg.toGroup)
          : roomsRef.current.find((r) => r.kind === "dm" && r.memberPeerIds.includes(fromPeerId));

        if (!targetRoom) return;

        // Deduplicate by msgId
        if (targetRoom.messages.some((m) => m.id === msg.msgId)) return;

        const newMsg: Msg = {
          id: msg.msgId,
          author: msg.from,
          authorName: msg.fromName,
          text: msg.type === "text" ? msg.text : undefined,
          imageDataUrl: msg.type === "image" ? msg.imageDataUrl : undefined,
          ts: msg.ts,
        };

        updateRoom(targetRoom.id, (r) => ({ ...r, messages: [...r.messages, newMsg] }));

        // Group host: relay to all other members
        if (msg.toGroup && targetRoom.isHost) {
          peerRef.current?.broadcast(msg, fromPeerId);
        }

        // Subtle notification if the window isn't focused (hidden, minimized, in background).
        if (!focusedRef.current && settingsRef.current.notifSound) {
          playNotifSound();
        }
      }
    };

    const handleConnect = (peerId: string) => {
      console.log("[peer] connected", peerId);
      // For each group room I host that doesn't include this peer yet, do nothing —
      // they'll send hello/messages and we already broadcast when needed.
      // Send membership snapshot for any group I host that this peer is part of.
      const myId = peerRef.current?.myId;
      if (!myId) return;
      const groupsHosted = roomsRef.current.filter((r) => r.kind === "group" && r.isHost && r.memberPeerIds.includes(peerId));
      for (const g of groupsHosted) {
        const allMembers = [
          { peerId: myId, name: peerRef.current!.myName },
          ...g.memberPeerIds.map((pid) => ({ peerId: pid, name: g.memberNames[pid] ?? "?" })),
        ];
        peerRef.current?.send(peerId, { type: "members", groupId: g.id, members: allMembers });
      }
    };

    const handleDisconnect = (peerId: string) => {
      console.log("[peer] disconnected", peerId);
    };

    const pm = new PeerManager(settings.myPeerId, settings.myName, {
      onReady: (id) => {
        setMyPeerId(id);
        setPeerReady(true);
        setSettings((s) => ({ ...s, myPeerId: id }));
        showToast(`Tu código: ${id}`);
      },
      onConnect: handleConnect,
      onDisconnect: handleDisconnect,
      onMessage: handleIncoming,
      onError: (err) => {
        console.error("[peer] error", err);
        showToast(`Error de conexión: ${err.message}`);
      },
      onRemoteStream: (fromPeerId, stream) => {
        setRemoteStreams((m) => {
          const next = new Map(m);
          next.set(fromPeerId, stream);
          return next;
        });
        // If the sender starts a fresh share, un-hide them so we see it.
        setHiddenStreamPeerIds((s) => {
          if (!s.has(fromPeerId)) return s;
          const next = new Set(s);
          next.delete(fromPeerId);
          return next;
        });
        showToast("Compartiendo pantalla contigo");
      },
      onRemoteStreamEnded: (fromPeerId) => {
        setRemoteStreams((m) => {
          const next = new Map(m);
          next.delete(fromPeerId);
          return next;
        });
        setImmersivePeerId((p) => (p === fromPeerId ? null : p));
      },
    });

    peerRef.current = pm;
    return () => {
      pm.destroy();
      peerRef.current = null;
    };
  }, [settings.myName, settings.myPeerId, updateRoom]);

  // Update peer name when local name changes
  useEffect(() => {
    if (peerRef.current && settings.myName) {
      peerRef.current.setName(settings.myName);
    }
  }, [settings.myName]);

  // Auto-reconnect to known peers on startup so contacts stay live across
  // app restarts / updates. Without this, the user has to re-create chats
  // every time because the live DataConnection dies when the app closes.
  useEffect(() => {
    if (!peerReady || !peerRef.current) return;
    const targets = new Set<string>();
    for (const r of roomsRef.current) {
      for (const pid of r.memberPeerIds) targets.add(pid);
    }
    for (const pid of targets) {
      if (peerRef.current.isLinked(pid)) continue;
      peerRef.current.connect(pid).catch((e) => {
        console.warn(`[peer] auto-reconnect to ${pid} failed:`, e?.message ?? e);
      });
    }
  }, [peerReady]);

  // Also retry auto-reconnect periodically for peers that aren't connected
  // (handles the case where the friend comes online later).
  useEffect(() => {
    if (!peerReady) return;
    const interval = setInterval(() => {
      const pm = peerRef.current;
      if (!pm) return;
      const targets = new Set<string>();
      for (const r of roomsRef.current) {
        for (const pid of r.memberPeerIds) targets.add(pid);
      }
      for (const pid of targets) {
        if (!pm.isLinked(pid)) {
          pm.connect(pid).catch(() => {});
        }
      }
    }, 20000);
    return () => clearInterval(interval);
  }, [peerReady]);

  // ===== Actions =====
  function sendText() {
    if (!activeRoom || !peerRef.current) return;
    const text = draft.trim();
    if (!text) return;

    const msgId = uid();
    const ts = Date.now();
    const localMsg: Msg = { id: msgId, author: "me", text, ts };
    updateRoom(activeRoom.id, (r) => ({ ...r, messages: [...r.messages, localMsg] }));

    const wire: WireMsg = {
      type: "text",
      msgId,
      from: peerRef.current.myId,
      fromName: settings.myName,
      text,
      ts,
      toGroup: activeRoom.kind === "group" ? activeRoom.id : undefined,
    };

    if (activeRoom.kind === "dm") {
      const target = activeRoom.memberPeerIds[0];
      if (target) peerRef.current.send(target, wire);
    } else {
      // group: send to all connected members
      for (const pid of activeRoom.memberPeerIds) {
        peerRef.current.send(pid, wire);
      }
    }

    setDraft("");
    inputRef.current?.focus();
  }

  function sendImageDataUrl(dataUrl: string) {
    if (!activeRoom || !peerRef.current) return;
    const msgId = uid();
    const ts = Date.now();
    updateRoom(activeRoom.id, (r) => ({
      ...r,
      messages: [...r.messages, { id: msgId, author: "me", imageDataUrl: dataUrl, ts }],
    }));
    const wire: WireMsg = {
      type: "image",
      msgId,
      from: peerRef.current.myId,
      fromName: settings.myName,
      imageDataUrl: dataUrl,
      ts,
      toGroup: activeRoom.kind === "group" ? activeRoom.id : undefined,
    };
    if (activeRoom.kind === "dm") {
      const target = activeRoom.memberPeerIds[0];
      if (target) peerRef.current.send(target, wire);
    } else {
      for (const pid of activeRoom.memberPeerIds) peerRef.current.send(pid, wire);
    }
  }

  async function attachImage() {
    if (!activeRoom || !peerRef.current) return;
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      if (!path || typeof path !== "string") return;
      const bytes = await readFile(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" ? "jpeg" : ext;
      const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
      sendImageDataUrl(`data:image/${mime};base64,${b64}`);
    } catch (e) {
      console.error(e);
      showToast("No se pudo enviar la imagen");
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!activeRoom || !peerRef.current) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          if (dataUrl) sendImageDataUrl(dataUrl);
        };
        reader.readAsDataURL(blob);
        e.preventDefault();
        return;
      }
    }
  }

  function createDM(targetPeerId: string, label: string) {
    if (!peerRef.current) return;
    const cleanId = targetPeerId.trim();
    if (!cleanId || cleanId === peerRef.current.myId) {
      showToast("Código inválido");
      return;
    }
    const id = uid();
    const room: Room = {
      id,
      kind: "dm",
      name: label.trim() || cleanId.slice(0, 8),
      hostPeerId: peerRef.current.myId,
      isHost: true,
      memberPeerIds: [cleanId],
      memberNames: { [cleanId]: label.trim() || "?" },
      mineColor: DEFAULT_MINE,
      theirsColor: DEFAULT_THEIRS,
      messages: [],
    };
    setRooms((rs) => [...rs, room]);
    setActiveId(id);
    peerRef.current.connect(cleanId).catch((e) => showToast(`No se pudo conectar: ${e.message}`));
    setNewRoomOpen(false);
  }

  function createGroup(groupName: string, memberIds: string[]) {
    if (!peerRef.current) return;
    const myId = peerRef.current.myId;
    const cleanMembers = memberIds.map((m) => m.trim()).filter((m) => m && m !== myId);
    if (cleanMembers.length === 0) {
      showToast("Agrega al menos un miembro");
      return;
    }
    const id = uid();
    const memberNames: Record<string, string> = {};
    for (const pid of cleanMembers) memberNames[pid] = pid.slice(0, 8);

    const room: Room = {
      id,
      kind: "group",
      name: groupName.trim() || "Grupo",
      hostPeerId: myId,
      isHost: true,
      memberPeerIds: cleanMembers,
      memberNames,
      mineColor: DEFAULT_MINE,
      theirsColor: DEFAULT_THEIRS,
      messages: [],
    };
    setRooms((rs) => [...rs, room]);
    setActiveId(id);

    // Connect to all members
    for (const pid of cleanMembers) {
      peerRef.current.connect(pid).catch((e) => console.warn(`connect ${pid} failed`, e));
    }
    setNewRoomOpen(false);
  }

  function joinByCode(code: string, label: string) {
    if (!peerRef.current) return;
    const targetId = code.trim();
    if (!targetId || targetId === peerRef.current.myId) {
      showToast("Código inválido");
      return;
    }
    // Create as DM toward that peer. If they're a group host, they'll send us "members"
    // and we'll attach to the group instead.
    const id = uid();
    const room: Room = {
      id,
      kind: "dm",
      name: label.trim() || targetId.slice(0, 8),
      hostPeerId: targetId,
      isHost: false,
      memberPeerIds: [targetId],
      memberNames: { [targetId]: label.trim() || "?" },
      mineColor: DEFAULT_MINE,
      theirsColor: DEFAULT_THEIRS,
      messages: [],
    };
    setRooms((rs) => [...rs, room]);
    setActiveId(id);
    peerRef.current.connect(targetId).catch((e) => showToast(`No se pudo conectar: ${e.message}`));
    setJoinOpen(false);
  }

  function removeRoom(id: string) {
    if (!confirm("¿Eliminar este chat?")) return;
    setRooms((rs) => {
      const next = rs.filter((r) => r.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? "");
      return next;
    });
  }

  function acceptRequest(peerId: string, name: string) {
    const id = uid();
    const room: Room = {
      id,
      kind: "dm",
      name: name || peerId.slice(0, 8),
      hostPeerId: peerId,
      isHost: false,
      memberPeerIds: [peerId],
      memberNames: { [peerId]: name || "?" },
      mineColor: DEFAULT_MINE,
      theirsColor: DEFAULT_THEIRS,
      messages: [],
    };
    setRooms((rs) => [...rs, room]);
    setActiveId(id);
    setIncomingRequests((reqs) => {
      const next = new Map(reqs);
      next.delete(peerId);
      return next;
    });
  }

  function rejectRequest(peerId: string) {
    setIncomingRequests((reqs) => {
      const next = new Map(reqs);
      next.delete(peerId);
      return next;
    });
    peerRef.current?.disconnect(peerId);
    if (activeId === `req-${peerId}`) {
      setActiveId(rooms[0]?.id ?? "");
    }
    showToast("Solicitud rechazada");
  }

  function copyMyId() {
    if (!myPeerId) return;
    navigator.clipboard.writeText(myPeerId).catch(() => {});
    showToast("Código copiado");
  }

  async function hideWindow() {
    // Hide (not minimize) so Ctrl+Shift+H is the consistent path to bring it back.
    await getCurrentWebviewWindow().hide();
  }
  async function closeWindow() { await getCurrentWebviewWindow().close(); }

  async function toggleScreenShare() {
    if (!activeRoom || !peerRef.current) return;
    if (peerRef.current.isSharing()) {
      peerRef.current.stopScreenShare();
      setIsSharing(false);
      showToast("Pantalla dejada de compartir");
      return;
    }
    const targets = activeRoom.memberPeerIds.filter((pid) => peerRef.current?.isConnected(pid));
    if (targets.length === 0) {
      showToast("Nadie conectado para ver la pantalla");
      return;
    }
    try {
      await peerRef.current.startScreenShare(targets);
      setIsSharing(true);
      showToast(`Compartiendo pantalla con ${targets.length}`);
    } catch (e: any) {
      console.error(e);
      if (e?.name === "NotAllowedError") {
        showToast("Permiso denegado");
      } else {
        showToast(`No se pudo compartir: ${e?.message ?? "error"}`);
      }
    }
  }

  // Membership status helper
  function peerStatus(roomId: string): { connected: number; total: number } {
    const r = rooms.find((x) => x.id === roomId);
    if (!r) return { connected: 0, total: 0 };
    const total = r.memberPeerIds.length;
    const connected = r.memberPeerIds.filter((pid) => peerRef.current?.isConnected(pid)).length;
    return { connected, total };
  }

  const showWelcome = rooms.length === 0 && incomingRequests.size === 0;
  const activeRequestPeerId = activeId.startsWith("req-") ? activeId.slice(4) : null;
  const activeRequestName = activeRequestPeerId ? incomingRequests.get(activeRequestPeerId) ?? null : null;

  // ===== Render =====
  return (
    <div className={`app ${focused ? "focused" : "blurred"} ${immersivePeerId ? "immersive-mode" : ""}`}>
      <header className="topbar" data-tauri-drag-region>
        <div className="tabs">
          {rooms.map((r) => {
            const st = peerStatus(r.id);
            const allOn = st.total > 0 && st.connected === st.total;
            return (
              <button
                key={r.id}
                className={`tab ${r.id === activeId ? "active" : ""}`}
                onClick={() => setActiveId(r.id)}
                onAuxClick={(e) => { if (e.button === 1) removeRoom(r.id); }}
                title={`${r.kind === "group" ? "Grupo · " : ""}${st.connected}/${st.total} conectados · click medio para eliminar`}
              >
                <span className={`dot ${allOn ? "on" : "off"}`} />
                <span className="tab-name">{r.name}</span>
              </button>
            );
          })}
          {[...incomingRequests.entries()].map(([peerId, name]) => (
            <button
              key={`req-${peerId}`}
              className={`tab tab-request ${activeId === `req-${peerId}` ? "active" : ""}`}
              onClick={() => setActiveId(`req-${peerId}`)}
              title={`${name} quiere chatear (click para revisar)`}
            >
              <span className="dot pulse" />
              <span className="tab-name">{name} ?</span>
            </button>
          ))}
          {(rooms.length > 0 || incomingRequests.size > 0) && (
            <button className="tab tab-add" onClick={() => setNewRoomOpen(true)} title="Nuevo chat o grupo">+</button>
          )}
        </div>
        <div className="winctl">
          <button className="winbtn" onClick={() => setSettingsOpen((s) => !s)} title="Ajustes">⚙</button>
          <button className="winbtn" onClick={hideWindow} title="Ocultar (Ctrl+Shift+H para volver)">–</button>
          <button className="winbtn winclose" onClick={closeWindow} title="Cerrar">×</button>
        </div>
      </header>

      {nameSetupOpen ? (
        <NameSetup
          onSubmit={(name) => {
            setSettings((s) => ({ ...s, myName: name }));
            setNameSetupOpen(false);
          }}
        />
      ) : activeRequestPeerId && activeRequestName !== null ? (
        <div className="welcome">
          <div className="welcome-card">
            <div className="welcome-title">Solicitud nueva</div>
            <div className="welcome-sub">
              <b>{activeRequestName}</b> quiere chatear contigo.
            </div>
            <div className="mycode">
              <span className="mycode-label">Su código:</span>
              <code className="mycode-val">{activeRequestPeerId}</code>
            </div>
            <div className="welcome-actions">
              <button className="primary" onClick={() => acceptRequest(activeRequestPeerId, activeRequestName)}>
                Aceptar y chatear
              </button>
              <button className="secondary" onClick={() => rejectRequest(activeRequestPeerId)}>
                Rechazar
              </button>
            </div>
            <div className="welcome-hint">
              Verifica el nombre/código con tu amigo antes de aceptar.
            </div>
          </div>
        </div>
      ) : showWelcome ? (
        <div className="welcome">
          <div className="welcome-card">
            <div className="welcome-title">Chati</div>
            <div className="welcome-sub">Hola <b>{settings.myName}</b>.</div>
            <div className="mycode">
              <span className="mycode-label">Tu código:</span>
              <code className="mycode-val">{peerReady ? myPeerId : "Conectando…"}</code>
              <button className="linkbtn" onClick={copyMyId} disabled={!peerReady}>copiar</button>
            </div>
            <div className="welcome-actions">
              <button className="primary" disabled={!peerReady} onClick={() => setNewRoomOpen(true)}>+ Crear chat o grupo</button>
              <button className="secondary" disabled={!peerReady} onClick={() => setJoinOpen(true)}>Unirse con código</button>
            </div>
            <div className="welcome-hint">
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> oculta/muestra · <kbd>⚙</kbd> ajustes
            </div>
          </div>
        </div>
      ) : activeRoom ? (
        <>
          {(() => {
            const roomStreams = [...remoteStreams.entries()].filter(
              ([pid]) => activeRoom.memberPeerIds.includes(pid) && !hiddenStreamPeerIds.has(pid),
            );
            const hiddenInRoom = activeRoom.memberPeerIds.filter(
              (pid) => remoteStreams.has(pid) && hiddenStreamPeerIds.has(pid),
            );
            const hasVideo = roomStreams.length > 0;
            const messagesPane = (
              <div className="chat" ref={scrollRef}>
                {hiddenInRoom.length > 0 && (
                  <div className="hidden-shares">
                    {hiddenInRoom.map((pid) => (
                      <button
                        key={pid}
                        className="hidden-share-btn"
                        onClick={() => {
                          setHiddenStreamPeerIds((s) => {
                            const next = new Set(s);
                            next.delete(pid);
                            return next;
                          });
                          showToast("Mostrando la pantalla otra vez");
                        }}
                        title="Volver a mostrar esta compartición"
                      >
                        🖥 {activeRoom.memberNames[pid] ?? pid.slice(0, 8)} comparte · <b>mostrar</b>
                      </button>
                    ))}
                  </div>
                )}
                {activeRoom.messages.length === 0 && (
                  <div className="empty-hint">
                    Sin mensajes en <b>{activeRoom.name}</b>.
                    {activeRoom.kind === "group" && (
                      <div className="members">
                        Miembros: {Object.values(activeRoom.memberNames).join(", ") || "(esperando)"}
                      </div>
                    )}
                    <div className="invite-block">
                      Tu código: <code>{myPeerId}</code>
                      <button className="linkbtn" onClick={copyMyId}>copiar</button>
                    </div>
                  </div>
                )}
                {activeRoom.messages.map((m) => (
                  <div key={m.id} className={`msg ${m.author === "me" ? "mine" : "theirs"}`}>
                    {m.author !== "me" && activeRoom.kind === "group" && (
                      <span className="msg-author">{m.authorName ?? activeRoom.memberNames[m.author as string] ?? "?"}</span>
                    )}
                    {m.text && <span className="msg-text">{m.text}</span>}
                    {m.imageDataUrl && <img className="msg-img" src={m.imageDataUrl} alt="imagen" onClick={() => setLightboxImage(m.imageDataUrl!)} title="Click para ver más grande" />}
                    <span className="msg-time">
                      {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                ))}
              </div>
            );

            if (!hasVideo) return messagesPane;

            return (
              <div
                className="split-content"
                style={{ ["--split-left" as any]: `${splitRatio * 100}%` }}
              >
                <div className="video-panel">
                  {roomStreams.map(([pid, stream]) => (
                    <RemoteVideo
                      key={pid}
                      stream={stream}
                      label={activeRoom.memberNames[pid] ?? pid.slice(0, 8)}
                      onClose={() => {
                        setHiddenStreamPeerIds((s) => {
                          const next = new Set(s);
                          next.add(pid);
                          return next;
                        });
                        showToast("Comparti ocultada (vuelve si comparten de nuevo)");
                      }}
                      onToggleImmersive={() =>
                        setImmersivePeerId((cur) => (cur === pid ? null : pid))
                      }
                    />
                  ))}
                </div>
                <div
                  className={`split-divider ${draggingSplit ? "dragging" : ""}`}
                  onMouseDown={() => setDraggingSplit(true)}
                  title="Arrastra para ajustar"
                />
                <div className="chat-panel">{messagesPane}</div>
              </div>
            );
          })()}

          <footer className="composer">
            <button className="iconbtn" onClick={attachImage} title="Adjuntar imagen" disabled={!peerReady}>🖼</button>
            <button
              className={`iconbtn ${isSharing ? "sharing" : ""}`}
              onClick={toggleScreenShare}
              title={isSharing ? "Dejar de compartir pantalla" : "Compartir pantalla"}
              disabled={!peerReady}
            >
              {isSharing ? "■" : "🖥"}
            </button>
            <textarea
              ref={inputRef}
              className="input"
              placeholder={peerReady ? "Mensaje (Ctrl+V pega imagen)…" : "Conectando…"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
              }}
              rows={1}
              disabled={!peerReady}
            />
            <button className="iconbtn send" onClick={sendText} title="Enviar (Enter)" disabled={!peerReady}>↑</button>
          </footer>
        </>
      ) : (
        <div className="welcome">
          <div className="welcome-card">
            <div className="welcome-sub">Elige un chat o crea uno nuevo.</div>
            <button className="primary" onClick={() => setNewRoomOpen(true)}>+ Crear chat o grupo</button>
          </div>
        </div>
      )}

      {/* Settings */}
      {settingsOpen && (
        <div className="settings" onClick={(e) => e.stopPropagation()}>
          <div className="settings-head">
            <span>Ajustes</span>
            <button className="winbtn" onClick={() => setSettingsOpen(false)}>×</button>
          </div>

          <div className="section-title">Identidad</div>
          <label className="row">
            <span>Tu nombre</span>
            <input
              type="text"
              value={settings.myName}
              onChange={(e) => setSettings((s) => ({ ...s, myName: e.target.value }))}
              className="thininput"
            />
          </label>
          <div className="row">
            <span>Tu código</span>
            <code className="row-code">{peerReady ? myPeerId : "…"}</code>
            <button className="linkbtn" onClick={copyMyId} disabled={!peerReady}>copiar</button>
          </div>

          <hr />
          <div className="section-title">Apariencia</div>
          <label className="row">
            <span title="0% = ventana totalmente invisible (sigue clickeable)">Opacidad app</span>
            <input type="range" min={0} max={1} step={0.01} value={settings.opacity}
              onChange={(e) => setSettings((s) => ({ ...s, opacity: parseFloat(e.target.value) }))} />
            <span className="row-val">{Math.round(settings.opacity * 100)}%</span>
          </label>
          <label className="row">
            <span>Color de letra</span>
            <input type="color" value={settings.fontColor}
              onChange={(e) => setSettings((s) => ({ ...s, fontColor: e.target.value }))} />
          </label>
          <label className="row">
            <span>Tinte de fondo</span>
            <input type="color" value={settings.bgTint}
              onChange={(e) => setSettings((s) => ({ ...s, bgTint: e.target.value }))} />
          </label>
          <label className="row">
            <span>Tamaño de letra</span>
            <input type="range" min={10} max={22} step={1} value={settings.fontSize}
              onChange={(e) => setSettings((s) => ({ ...s, fontSize: parseInt(e.target.value) }))} />
            <span className="row-val">{settings.fontSize}px</span>
          </label>

          {activeRoom && (
            <>
              <hr />
              <div className="section-title">Burbujas de "{activeRoom.name}"</div>
              <label className="row">
                <span>Mis: color</span>
                <input type="color" value={activeRoom.mineColor}
                  onChange={(e) => updateRoom(activeRoom.id, (r) => ({ ...r, mineColor: e.target.value }))} />
              </label>
              <label className="row">
                <span>Mis: opacidad</span>
                <input type="range" min={0} max={1} step={0.01}
                  value={activeRoom.mineOpacity ?? 1}
                  onChange={(e) => updateRoom(activeRoom.id, (r) => ({ ...r, mineOpacity: parseFloat(e.target.value) }))} />
                <span className="row-val">{Math.round((activeRoom.mineOpacity ?? 1) * 100)}%</span>
              </label>
              <label className="row">
                <span>Otros: color</span>
                <input type="color" value={activeRoom.theirsColor}
                  onChange={(e) => updateRoom(activeRoom.id, (r) => ({ ...r, theirsColor: e.target.value }))} />
              </label>
              <label className="row">
                <span>Otros: opacidad</span>
                <input type="range" min={0} max={1} step={0.01}
                  value={activeRoom.theirsOpacity ?? 1}
                  onChange={(e) => updateRoom(activeRoom.id, (r) => ({ ...r, theirsOpacity: parseFloat(e.target.value) }))} />
                <span className="row-val">{Math.round((activeRoom.theirsOpacity ?? 1) * 100)}%</span>
              </label>
              <button className="linkbtn"
                onClick={() => updateRoom(activeRoom.id, (r) => ({ ...r, mineColor: DEFAULT_MINE, theirsColor: DEFAULT_THEIRS, mineOpacity: 1, theirsOpacity: 1 }))}>
                restablecer
              </button>

              <hr />
              <div className="section-title">Gestión del chat</div>
              <button
                className="danger-btn"
                onClick={() => removeRoom(activeRoom.id)}
                title="Elimina este chat / contacto de la lista"
              >
                🗑 Eliminar este chat
              </button>
            </>
          )}

          <hr />
          <div className="section-title">Modo sigilo</div>
          <label className="row toggle">
            <span>Invisible en capturas</span>
            <input type="checkbox" checked={settings.contentProtected}
              onChange={(e) => setSettings((s) => ({ ...s, contentProtected: e.target.checked }))} />
          </label>
          <label className="row toggle">
            <span>Siempre encima</span>
            <input type="checkbox" checked={settings.alwaysOnTop}
              onChange={(e) => setSettings((s) => ({ ...s, alwaysOnTop: e.target.checked }))} />
          </label>
          <label className="row toggle">
            <span>Ocultar de barra de tareas</span>
            <input type="checkbox" checked={settings.skipTaskbar}
              onChange={(e) => setSettings((s) => ({ ...s, skipTaskbar: e.target.checked }))} />
          </label>
          <label className="row toggle">
            <span title="Beep suave cuando llega mensaje y la ventana no está enfocada">
              Sonido al recibir mensaje
            </span>
            <input
              type="checkbox"
              checked={settings.notifSound}
              onChange={(e) => setSettings((s) => ({ ...s, notifSound: e.target.checked }))}
            />
          </label>
          <label className="row toggle">
            <span title="Cuidado: con esto activado no podrás clickear nada hasta que lo apagues con Ctrl+Shift+H">
              Click a través ⚠
            </span>
            <input
              type="checkbox"
              checked={settings.clickThrough}
              onChange={(e) => {
                const next = e.target.checked;
                if (next) {
                  if (!confirm("Atención: si activas click-a-través no podrás clickear la ventana. Para desactivarlo: presiona Ctrl+Shift+H (oculta) y vuelve a presionarlo (la app reabre con click-a-través apagado).")) return;
                  showToast("Click-a-través activo. Ctrl+Shift+H para escapar.", 4000);
                }
                setSettings((s) => ({ ...s, clickThrough: next }));
              }}
            />
          </label>

          <div className="hint">
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> oculta/muestra (también apaga click-a-través)
          </div>

          <hr />
          <div className="section-title">Actualizaciones</div>
          <div className="row">
            <span>Versión actual</span>
            <code className="row-code">v{appVersion || "…"}</code>
          </div>
          <div className="row">
            <span>
              {checkStatus === "checking" && "Buscando…"}
              {checkStatus === "uptodate" && "✓ Estás al día"}
              {checkStatus === "found" && "Nueva versión disponible ↓"}
              {checkStatus === "error" && "Error al buscar"}
              {checkStatus === "idle" && "Buscar nueva versión"}
            </span>
            <button
              className="primary"
              style={{ padding: "4px 10px", fontSize: 11 }}
              onClick={manualCheck}
              disabled={checkStatus === "checking" || updating}
            >
              {checkStatus === "checking" ? "…" : "Actualizar"}
            </button>
          </div>
        </div>
      )}

      {newRoomOpen && (
        <NewRoomModal
          onClose={() => setNewRoomOpen(false)}
          onCreateDM={createDM}
          onCreateGroup={createGroup}
          myPeerId={myPeerId}
        />
      )}

      {joinOpen && (
        <JoinModal onClose={() => setJoinOpen(false)} onJoin={joinByCode} />
      )}

      {immersivePeerId && remoteStreams.has(immersivePeerId) && !hiddenStreamPeerIds.has(immersivePeerId) && (
        <div className="immersive-overlay">
          <ImmersiveVideo stream={remoteStreams.get(immersivePeerId)!} />

          {/* Floating "exit" + label, dimmed by default, opaque on hover */}
          <div className="immersive-hud" onMouseDown={(e) => e.stopPropagation()}>
            <span>
              {activeRoom?.memberNames[immersivePeerId] ??
                rooms.find((r) => r.memberPeerIds.includes(immersivePeerId))?.memberNames[immersivePeerId] ??
                immersivePeerId.slice(0, 8)}
            </span>
            <button
              className="rv-btn"
              onClick={() => { setImmersivePeerId(null); setImmersiveChatOpen(false); }}
              title="Salir del modo inmersivo (Esc)"
            >✕ salir</button>
          </div>

          {/* Floating chat toggle bottom-right */}
          <button
            className={`immersive-chat-btn ${immersiveChatOpen ? "open" : ""}`}
            onClick={() => setImmersiveChatOpen((v) => !v)}
            title={immersiveChatOpen ? "Cerrar mini chat" : "Abrir mini chat para escribir"}
          >
            {immersiveChatOpen ? "▾" : "💬"}
          </button>

          {/* Floating mini chat with composer */}
          {immersiveChatOpen && activeRoom && (
            <div className="floating-chat" onMouseDown={(e) => e.stopPropagation()}>
              <div className="fc-header">
                <span>{activeRoom.name}</span>
              </div>
              <div className="fc-messages">
                {activeRoom.messages.length === 0 && (
                  <div className="fc-empty">Aún sin mensajes</div>
                )}
                {activeRoom.messages.slice(-8).map((m) => (
                  <div key={m.id} className={`msg ${m.author === "me" ? "mine" : "theirs"}`}>
                    {m.author !== "me" && activeRoom.kind === "group" && (
                      <span className="msg-author">{m.authorName ?? activeRoom.memberNames[m.author as string] ?? "?"}</span>
                    )}
                    {m.text && <span className="msg-text">{m.text}</span>}
                    {m.imageDataUrl && <img className="msg-img" src={m.imageDataUrl} alt="imagen" onClick={() => setLightboxImage(m.imageDataUrl!)} title="Click para ver más grande" />}
                  </div>
                ))}
              </div>
              <div className="fc-composer">
                <button className="iconbtn" onClick={attachImage} title="Adjuntar imagen" disabled={!peerReady}>🖼</button>
                <textarea
                  className="input"
                  placeholder={peerReady ? "Mensaje…" : "Conectando…"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
                  }}
                  rows={1}
                  disabled={!peerReady}
                />
                <button className="iconbtn send" onClick={sendText} disabled={!peerReady} title="Enviar (Enter)">↑</button>
              </div>
            </div>
          )}
        </div>
      )}

      {lightboxImage && (
        <div className="lightbox-backdrop" onClick={() => setLightboxImage(null)}>
          <img className="lightbox-img" src={lightboxImage} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightboxImage(null)} title="Cerrar (Esc)">✕</button>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {updateAvailable && !updating && (
        <div className="update-banner">
          <span>
            Nueva versión <b>{updateAvailable.version}</b> disponible
          </span>
          <div className="update-actions">
            <button className="linkbtn" onClick={() => setUpdateAvailable(null)}>Más tarde</button>
            <button className="primary update-btn" onClick={installUpdate}>Actualizar</button>
          </div>
        </div>
      )}

      {updating && (
        <div className="update-banner">
          <span>
            Actualizando…
            {updateProgress && updateProgress.total ? ` ${Math.round((updateProgress.downloaded / updateProgress.total) * 100)}%` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function RemoteVideo({
  stream,
  label,
  onClose,
  onToggleImmersive,
}: {
  stream: MediaStream;
  label: string;
  onClose?: () => void;
  onToggleImmersive?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  function reset() {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }

  function handleWheel(e: React.WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    setZoom((z) => {
      const next = Math.max(1, Math.min(8, z * factor));
      if (next === 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1) return;
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y };
  }

  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: MouseEvent) {
      setOffset({
        x: dragStart.current.ox + (ev.clientX - dragStart.current.mx),
        y: dragStart.current.oy + (ev.clientY - dragStart.current.my),
      });
    }
    function onUp() { setDragging(false); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const cursor = zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in";

  return (
    <div
      ref={wrapRef}
      className="remote-video"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => onToggleImmersive?.()}
      style={{ cursor }}
      title="Ctrl+rueda: zoom · arrastra: mover · doble click: pantalla completa real"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transformOrigin: "center center",
          transition: dragging ? "none" : "transform 0.05s linear",
        }}
        draggable={false}
      />
      <div className="remote-video-label">{label}</div>
      <div className="remote-video-controls" onMouseDown={(e) => e.stopPropagation()}>
        {onToggleImmersive && (
          <button
            className="rv-btn"
            onClick={(e) => { e.stopPropagation(); onToggleImmersive(); }}
            title="Modo inmersivo (Ctrl+Shift+M, Esc para salir)"
          >⛶</button>
        )}
        {onClose && (
          <button
            className="rv-btn rv-close"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Cerrar esta compartición"
          >✕</button>
        )}
      </div>
      {zoom > 1 && (
        <button className="zoom-reset" onClick={(e) => { e.stopPropagation(); reset(); }}>
          {Math.round(zoom * 100)}% · reset
        </button>
      )}
    </div>
  );
}

/**
 * Dual-layer video: a blurred copy of the same stream covers the background
 * (filling the area without black bars), and the real video sits on top with
 * aspect ratio preserved. Same technique YouTube and Instagram use to handle
 * mismatched aspect ratios without distorting the content.
 */
function ImmersiveVideo({ stream }: { stream: MediaStream }) {
  const bgRef = useRef<HTMLVideoElement>(null);
  const fgRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (bgRef.current) bgRef.current.srcObject = stream;
    if (fgRef.current) fgRef.current.srcObject = stream;
  }, [stream]);
  return (
    <>
      <video ref={bgRef} className="immersive-bg" autoPlay playsInline muted />
      <video ref={fgRef} className="immersive-fg" autoPlay playsInline muted />
    </>
  );
}

function NameSetup({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-title">stealth-chat</div>
        <div className="welcome-sub">¿Cómo quieres que te vean tus amigos?</div>
        <input
          autoFocus
          className="bigInput"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tu nombre"
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSubmit(name.trim()); }}
          maxLength={24}
        />
        <button className="primary" disabled={!name.trim()} onClick={() => onSubmit(name.trim())}>
          Empezar
        </button>
      </div>
    </div>
  );
}

function NewRoomModal({
  onClose, onCreateDM, onCreateGroup, myPeerId,
}: {
  onClose: () => void;
  onCreateDM: (peerId: string, label: string) => void;
  onCreateGroup: (groupName: string, memberIds: string[]) => void;
  myPeerId: string;
}) {
  const [kind, setKind] = useState<RoomKind>("dm");
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [groupName, setGroupName] = useState("");
  const [membersRaw, setMembersRaw] = useState("");

  function submit() {
    if (kind === "dm") {
      if (!target.trim()) return;
      onCreateDM(target, label);
    } else {
      const members = membersRaw.split(/[,\n\s]+/).map((s) => s.trim()).filter(Boolean);
      if (members.length === 0) return;
      onCreateGroup(groupName, members);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Nuevo chat o grupo</span>
          <button className="winbtn" onClick={onClose}>×</button>
        </div>
        <div className="segctl">
          <button className={kind === "dm" ? "seg active" : "seg"} onClick={() => setKind("dm")}>Chat 1-a-1</button>
          <button className={kind === "group" ? "seg active" : "seg"} onClick={() => setKind("group")}>Grupo</button>
        </div>

        {kind === "dm" ? (
          <>
            <label className="modal-row">
              <span>Código de tu amigo</span>
              <input autoFocus type="text" value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="código de PeerJS"
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            </label>
            <label className="modal-row">
              <span>Nombre que quieres ponerle</span>
              <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Mau" />
            </label>
          </>
        ) : (
          <>
            <label className="modal-row">
              <span>Nombre del grupo</span>
              <input autoFocus type="text" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Equipo de mate" />
            </label>
            <label className="modal-row">
              <span>Códigos de los miembros (separados por coma o salto de línea)</span>
              <textarea rows={4} value={membersRaw} onChange={(e) => setMembersRaw(e.target.value)} placeholder="abc123\ndef456\nghi789" />
            </label>
            <div className="hint">Tú serás el host: los demás se conectarán a través tuyo.</div>
          </>
        )}

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={submit}>Crear</button>
        </div>
        <div className="hint">
          Tu código: <code>{myPeerId || "…"}</code> — Compártelo si quieres que se unan a ti.
        </div>
      </div>
    </div>
  );
}

function JoinModal({ onClose, onJoin }: { onClose: () => void; onJoin: (code: string, label: string) => void }) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Unirse con código</span>
          <button className="winbtn" onClick={onClose}>×</button>
        </div>
        <label className="modal-row">
          <span>Código de quien te invitó</span>
          <input autoFocus type="text" value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="código de PeerJS"
            onKeyDown={(e) => { if (e.key === "Enter") onJoin(code, label); }} />
        </label>
        <label className="modal-row">
          <span>Nombre que quieres ponerle</span>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Diego" />
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={() => onJoin(code, label)} disabled={!code.trim()}>Unirme</button>
        </div>
      </div>
    </div>
  );
}
