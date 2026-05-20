import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { PeerManager, WireMsg, ReplyRef, IncomingVoiceCall } from "./peer";
import { saveMessageToDb, loadMessagesFromDb, deleteRoomMessagesFromDb } from "./db";

type RoomKind = "dm" | "group";

type Msg = {
  id: string;
  author: "me" | string;        // "me" or peer ID
  authorName?: string;
  text?: string;
  imageDataUrl?: string;
  ts: number;
  replyTo?: ReplyRef;
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
  toggleShortcut?: string;
  geminiApiKey?: string;
  sidebarMode?: boolean;
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
  toggleShortcut: "Ctrl+Shift+H",
  sidebarMode: false,
};

type ActivityItem = {
  id: string;
  ts: number;
  text: string;
  kind: "msg" | "voice" | "share" | "system";
  roomId?: string;
};

// Subtle generated chime — no asset needed. Two short pure tones, total ~280ms.
// We keep one long-lived AudioContext to avoid the "user gesture required" lockouts
// that hit new AudioContexts in some webview/browser policy combinations.
let sharedAudioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  try {
    if (sharedAudioCtx) return sharedAudioCtx;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    sharedAudioCtx = new AC();
    return sharedAudioCtx;
  } catch {
    return null;
  }
}
function playNotifSound() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    // Resume if suspended (some webviews start contexts suspended until first gesture).
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const beep = (start: number, freq: number, dur: number, peak = 0.18) => {
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
  } catch (e) {
    console.warn("[notif] sound failed", e);
  }
}

const LS_ROOMS = "sc.rooms";
const LS_SETTINGS = "sc.settings";
const LS_ACTIVE = "sc.activeId";
const LS_STICKERS = "sc.stickers";

type Sticker = { id: string; dataUrl: string; name: string };

function loadStickers(): Sticker[] {
  try {
    const raw = localStorage.getItem(LS_STICKERS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStickersLs(items: Sticker[]) {
  try {
    localStorage.setItem(LS_STICKERS, JSON.stringify(items));
  } catch (e) {
    console.warn("[stickers] localStorage full", e);
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ===== Inline SVG icons (monochrome, currentColor) =====
// Stroked line-art icons in the Lucide style. Single-color, scalable, no emoji color.
const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactElement> = {
    phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.97.37 1.92.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.89.33 1.84.57 2.81.7A2 2 0 0 1 22 16.92Z"/>,
    "phone-off": <><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-3.4-2.85"/><path d="M5.27 5.27A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.97.37 1.92.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" y1="2" x2="2" y2="22"/></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10a7 7 0 0 1-14 0"/><line x1="12" y1="17" x2="12" y2="22"/></>,
    "mic-off": <><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 5a3 3 0 0 1 6 0v6"/><path d="M9 9v2a3 3 0 0 0 5.12 2.12"/><path d="M19 10a7 7 0 0 1-.11 1.23"/><path d="M17.94 17.94A7 7 0 0 1 5 10"/><line x1="12" y1="17" x2="12" y2="22"/></>,
    cam: <><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></>,
    "cam-off": <><line x1="2" y1="2" x2="22" y2="22"/><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3l3 3"/><path d="M9 5h5a2 2 0 0 1 2 2v5l4 4V7l-7 5"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></>,
    monitor: <><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></>,
    "monitor-off": <><line x1="2" y1="2" x2="22" y2="22"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M20.4 15.4A2 2 0 0 1 19 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 1.6-1.96"/><path d="M8 3h13a2 2 0 0 1 2 2v8.5"/></>,
    music: <><path d="M9 17V5l11-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="17" cy="15" r="3"/></>,
    send: <><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.16.69.41.95.73.27.31.46.69.56 1.09v.18a2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z"/></>,
    minimize: <line x1="5" y1="12" x2="19" y2="12"/>,
    x: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    reply: <><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></>,
    sticker: <><circle cx="12" cy="12" r="10"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></>,
  };
  return (
    <svg width={size} height={size} {...ICON_PROPS}>
      {paths[name]}
    </svg>
  );
}

function loadRooms(): Room[] {
  try {
    const raw = localStorage.getItem(LS_ROOMS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Room[];
    // Start with empty messages — they'll be hydrated from IndexedDB after mount.
    return parsed.map((r) => ({ ...r, messages: [] }));
  } catch {
    return [];
  }
}

// Room metadata in localStorage is small (no messages). Messages live in IndexedDB
// which has a much larger quota (typically 50MB-1GB).
function saveRooms(rooms: Room[]) {
  const stripped = rooms.map((r) => ({ ...r, messages: [] }));
  try {
    localStorage.setItem(LS_ROOMS, JSON.stringify(stripped));
  } catch (e) {
    console.warn("[rooms] localStorage write failed", e);
  }
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
  // Per-room unread counts. Cleared when the room becomes active or is opened.
  const [unread, setUnread] = useState<Record<string, number>>({});
  // Floating notification (mini-message ribbon) shown for new incoming messages.
  const [msgNotif, setMsgNotif] = useState<{ author: string; preview: string; roomId: string; ts: number } | null>(null);
  const msgNotifTimer = useRef<number | null>(null);
  // Voice call state
  const [voiceActive, setVoiceActive] = useState(false);
  const voiceActiveRef = useRef(false);
  useEffect(() => { voiceActiveRef.current = voiceActive; }, [voiceActive]);
  // Track when the active call started so we can show elapsed time.
  const [callStartTs, setCallStartTs] = useState<number | null>(null);
  const [callTick, setCallTick] = useState(0);
  // Re-render every second while a call is active so the timer ticks.
  useEffect(() => {
    if (!callStartTs) return;
    const id = setInterval(() => setCallTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [callStartTs]);
  const [micMuted, setMicMuted] = useState(false);
  const [remoteVoiceStreams, setRemoteVoiceStreams] = useState<Map<string, MediaStream>>(new Map());
  // Incoming voice call awaiting accept/reject
  const [incomingCall, setIncomingCall] = useState<IncomingVoiceCall | null>(null);
  const [incomingCallName, setIncomingCallName] = useState<string>("");
  // Camera state
  const [cameraActive, setCameraActive] = useState(false);
  const [localCameraStream, setLocalCameraStream] = useState<MediaStream | null>(null);
  const [remoteCameraStreams, setRemoteCameraStreams] = useState<Map<string, MediaStream>>(new Map());
  // Reply state — when set, the next outgoing message will quote this one.
  const [replyingTo, setReplyingTo] = useState<ReplyRef | null>(null);
  // @ mention autocomplete state
  const [mentionState, setMentionState] = useState<{ query: string; atIndex: number } | null>(null);
  // Shared YouTube player state (only one active per room)
  const [musicVideoId, setMusicVideoId] = useState<string | null>(null);
  const [musicOpen, setMusicOpen] = useState(false);
  const [musicHostId, setMusicHostId] = useState<string | null>(null);
  const [musicPickerOpen, setMusicPickerOpen] = useState(false);
  const [stickers, setStickers] = useState<Sticker[]>(() => loadStickers());
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [hotkeyEditorOpen, setHotkeyEditorOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  function pushActivity(item: Omit<ActivityItem, "id" | "ts">) {
    setActivity((a) => [{ id: uid(), ts: Date.now(), ...item }, ...a].slice(0, 50));
  }
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

  // Hydrate messages from IndexedDB on mount. Older messages persist forever now.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = rooms.map((r) => r.id);
      for (const id of ids) {
        try {
          const msgs = await loadMessagesFromDb(id, 500);
          if (cancelled) return;
          if (msgs.length === 0) continue;
          setRooms((rs) =>
            rs.map((r) =>
              r.id === id ? { ...r, messages: msgs as Msg[] } : r,
            ),
          );
        } catch (e) {
          console.warn("[db] hydrate failed for room", id, e);
        }
      }
    })();
    return () => { cancelled = true; };
    // Only on mount — subsequent room additions hydrate from network sends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveStickersLs(stickers), [stickers]);
  useEffect(() => {
    if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
    // Mark the now-active room as read
    if (activeId) {
      setUnread((u) => {
        if (!u[activeId]) return u;
        const next = { ...u };
        delete next[activeId];
        return next;
      });
    }
  }, [activeId]);

  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

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

  // Make the OS window fullscreen while in immersive mode so the video fills the whole monitor.
  // Belt-and-suspenders: setFullscreen + also fallback to manually resizing to monitor bounds
  // in case setFullscreen has quirks with transparent/alwaysOnTop windows.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    (async () => {
      try {
        if (immersivePeerId) {
          await win.setFullscreen(true);
        } else {
          await win.setFullscreen(false);
        }
      } catch (e) {
        console.warn("[fullscreen] toggle failed", e);
      }
    })();
  }, [immersivePeerId]);

  // Ctrl+K opens the command palette globally
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // Apply saved toggle shortcut on startup (in case user changed it from default).
  useEffect(() => {
    const sc = settings.toggleShortcut ?? "Ctrl+Shift+H";
    if (sc === "Ctrl+Shift+H") return; // already registered by Rust setup
    invoke("set_toggle_shortcut", { shortcut: sc }).catch((e) =>
      console.warn("[shortcut] could not apply saved shortcut", e),
    );
  }, []);

  function applyNewShortcut(combo: string) {
    invoke("set_toggle_shortcut", { shortcut: combo })
      .then(() => {
        setSettings((s) => ({ ...s, toggleShortcut: combo }));
        setHotkeyEditorOpen(false);
        showToast(`Atajo cambiado a ${combo}`);
      })
      .catch((e) => {
        console.error(e);
        showToast(`No se pudo cambiar el atajo: ${e}`);
      });
  }

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

  function forceReconnectAll() {
    const pm = peerRef.current;
    if (!pm) return;
    pm.forceSignalingReconnect();
    pm.clearInFlight();
    let attempted = 0;
    for (const r of roomsRef.current) {
      for (const pid of r.memberPeerIds) {
        if (!pm.isConnected(pid)) {
          pm.connect(pid).catch(() => {});
          attempted++;
        }
      }
    }
    showToast(`Reintentando ${attempted} conexion(es)…`);
  }

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

  // Stable updateRoom helper. Detects added messages and writes them to IndexedDB
  // for permanent storage (so they survive restarts and aren't capped by localStorage).
  const updateRoom = useCallback((id: string, fn: (r: Room) => Room) => {
    setRooms((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const next = fn(r);
        // Save any new messages to IDB asynchronously.
        const oldIds = new Set(r.messages.map((m) => m.id));
        for (const m of next.messages) {
          if (!oldIds.has(m.id)) {
            saveMessageToDb(id, {
              id: m.id,
              ts: m.ts,
              author: m.author,
              authorName: m.authorName,
              text: m.text,
              imageDataUrl: m.imageDataUrl,
              replyTo: m.replyTo,
            }).catch((e) => console.warn("[db] save failed", e));
          }
        }
        return next;
      }),
    );
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

      if (msg.type === "music-open") {
        setMusicVideoId(msg.videoId);
        setMusicHostId(fromPeerId);
        setMusicOpen(true);
        return;
      }
      if (msg.type === "music-close") {
        setMusicVideoId(null);
        setMusicHostId(null);
        setMusicOpen(false);
        return;
      }
      if (msg.type === "music-state") {
        // Forward to the player via a custom DOM event so the YT player can react.
        window.dispatchEvent(new CustomEvent("yt-sync-state", { detail: msg }));
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
          replyTo: msg.replyTo,
        };

        updateRoom(targetRoom.id, (r) => ({ ...r, messages: [...r.messages, newMsg] }));

        // Group host: relay to all other members
        if (msg.toGroup && targetRoom.isHost) {
          peerRef.current?.broadcast(msg, fromPeerId);
        }

        // Gemini AI: if I host this room and the text starts with @gemini, call the API
        // on behalf of the requester and broadcast the answer.
        if (msg.type === "text" && targetRoom.isHost && /^@gemini\b/i.test(msg.text)) {
          const apiKey = settingsRef.current.geminiApiKey;
          if (apiKey) {
            handleGeminiRequest(msg.text.replace(/^@gemini\b/i, "").trim(), targetRoom);
          }
        }

        const authorN = msg.fromName || targetRoom.memberNames[fromPeerId] || fromPeerId.slice(0, 8);
        const previewT = (msg.type === "text" ? msg.text : "🖼 imagen").slice(0, 60);
        pushActivity({
          kind: "msg",
          text: `${authorN}: ${previewT}`,
          roomId: targetRoom.id,
        });

        const isActiveAndFocused = activeIdRef.current === targetRoom.id && focusedRef.current;
        if (!isActiveAndFocused) {
          // Bump unread badge for this room
          setUnread((u) => ({ ...u, [targetRoom.id]: (u[targetRoom.id] ?? 0) + 1 }));
          // Floating mini-message ribbon at top of window
          const preview = (msg.type === "text" ? msg.text : "🖼 imagen") ?? "";
          const author =
            msg.fromName
            || targetRoom.memberNames[fromPeerId]
            || fromPeerId.slice(0, 8);
          setMsgNotif({ author, preview: preview.slice(0, 80), roomId: targetRoom.id, ts: Date.now() });
          if (msgNotifTimer.current) window.clearTimeout(msgNotifTimer.current);
          msgNotifTimer.current = window.setTimeout(() => setMsgNotif(null), 4500);
          // Subtle chime
          if (settingsRef.current.notifSound) playNotifSound();
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

    let alreadyReady = false;
    const pm = new PeerManager(settings.myPeerId, settings.myName, {
      onReady: (id) => {
        setMyPeerId(id);
        setPeerReady(true);
        setSettings((s) => ({ ...s, myPeerId: id }));
        // Show the toast only the first time per session — silent on reconnects.
        if (!alreadyReady) {
          alreadyReady = true;
          showToast("Conectado");
        }
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
        const r = roomsRef.current.find((r) => r.memberPeerIds.includes(fromPeerId));
        const name = r?.memberNames[fromPeerId] ?? fromPeerId.slice(0, 8);
        pushActivity({ kind: "share", text: `${name} comparte pantalla`, roomId: r?.id });
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
      onRemoteVoice: (fromPeerId, stream) => {
        setRemoteVoiceStreams((m) => {
          const next = new Map(m);
          next.set(fromPeerId, stream);
          return next;
        });
      },
      onRemoteVoiceEnded: (fromPeerId) => {
        setRemoteVoiceStreams((m) => {
          const next = new Map(m);
          next.delete(fromPeerId);
          // Auto-leave if no other voices remain — covers 1-on-1 (other hangs up)
          // and group calls where we end up alone.
          if (next.size === 0 && voiceActiveRef.current) {
            setTimeout(() => {
              if (voiceActiveRef.current && peerRef.current?.isVoiceActive()) {
                endCallLocal("Te quedaste solo · llamada finalizada");
              }
            }, 400);
          }
          return next;
        });
      },
      onIncomingVoiceCall: (info) => {
        // Find friendly name for this caller from any room we share
        const name =
          roomsRef.current.find((r) => r.memberPeerIds.includes(info.peerId))?.memberNames[info.peerId]
          ?? info.peerId.slice(0, 8);
        setIncomingCall(info);
        setIncomingCallName(name);
        showToast(`${name} te está llamando`, 4000);
        pushActivity({ kind: "voice", text: `${name} te está llamando` });
      },
      onRemoteCamera: (fromPeerId, stream) => {
        setRemoteCameraStreams((m) => {
          const next = new Map(m);
          next.set(fromPeerId, stream);
          return next;
        });
      },
      onRemoteCameraEnded: (fromPeerId) => {
        setRemoteCameraStreams((m) => {
          const next = new Map(m);
          next.delete(fromPeerId);
          return next;
        });
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
      // Recover the signaling link if it dropped (common after sleep/wake).
      if (pm.isSignalingDown()) {
        pm.forceSignalingReconnect();
      }
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

  // Wake-from-sleep detection: setInterval ticks should land ~1s apart.
  // If a tick is way late, the laptop was sleeping. Force a reconnect immediately
  // (don't wait for the 20s interval above).
  useEffect(() => {
    if (!peerReady) return;
    let lastTick = Date.now();
    function tick() {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > 5000) {
        console.log(`[wake] Detected sleep/wake gap of ${gap}ms — forcing reconnect`);
        const pm = peerRef.current;
        if (pm) {
          pm.forceSignalingReconnect();
          for (const r of roomsRef.current) {
            for (const pid of r.memberPeerIds) {
              if (!pm.isLinked(pid)) pm.connect(pid).catch(() => {});
            }
          }
        }
      }
    }
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [peerReady]);

  // Network-online recovery: browser fires `online` when the network adapter comes back.
  useEffect(() => {
    if (!peerReady) return;
    function onOnline() {
      console.log("[network] back online — forcing reconnect");
      const pm = peerRef.current;
      if (!pm) return;
      // Small delay to let the network actually settle before retrying
      setTimeout(() => {
        pm.forceSignalingReconnect();
        for (const r of roomsRef.current) {
          for (const pid of r.memberPeerIds) {
            if (!pm.isLinked(pid)) pm.connect(pid).catch(() => {});
          }
        }
      }, 1500);
    }
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [peerReady]);

  // ===== Actions =====
  async function handleGeminiRequest(prompt: string, room: Room) {
    const apiKey = settingsRef.current.geminiApiKey;
    if (!apiKey || !peerRef.current) return;
    // Use last few messages as light context so Gemini understands the convo flow.
    const ctx = room.messages.slice(-8).map((m) => {
      const author = m.author === "me" ? "yo" : (m.authorName ?? room.memberNames[m.author as string] ?? "amigo");
      return `${author}: ${m.text ?? "(imagen)"}`;
    }).join("\n");
    const fullPrompt = ctx ? `Contexto del chat:\n${ctx}\n\nPregunta:\n${prompt}` : prompt;
    let reply = "";
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }] }),
        },
      );
      if (!res.ok) {
        const errText = await res.text();
        reply = `(error de Gemini: ${res.status}) ${errText.slice(0, 200)}`;
      } else {
        const data = await res.json();
        reply = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(sin respuesta)";
      }
    } catch (e: any) {
      reply = `(error de red: ${e?.message ?? "desconocido"})`;
    }
    // Send Gemini's reply as a regular text message attributed to "Gemini".
    const msgId = uid();
    const ts = Date.now();
    const wire: WireMsg = {
      type: "text",
      msgId,
      from: "gemini-bot",
      fromName: "🤖 Gemini",
      text: reply,
      ts,
      toGroup: room.kind === "group" ? room.id : undefined,
    };
    // Show locally
    updateRoom(room.id, (r) => ({
      ...r,
      messages: [...r.messages, { id: msgId, author: "gemini-bot", authorName: "🤖 Gemini", text: reply, ts }],
    }));
    // Broadcast
    if (room.kind === "dm") {
      const target = room.memberPeerIds[0];
      if (target) peerRef.current.send(target, wire);
    } else {
      for (const pid of room.memberPeerIds) peerRef.current.send(pid, wire);
    }
  }

  function sendText() {
    if (!activeRoom || !peerRef.current) return;
    const text = draft.trim();
    if (!text) return;

    const msgId = uid();
    const ts = Date.now();
    const replyRef = replyingTo ?? undefined;
    const localMsg: Msg = { id: msgId, author: "me", text, ts, replyTo: replyRef };
    updateRoom(activeRoom.id, (r) => ({ ...r, messages: [...r.messages, localMsg] }));

    const wire: WireMsg = {
      type: "text",
      msgId,
      from: peerRef.current.myId,
      fromName: settings.myName,
      text,
      ts,
      toGroup: activeRoom.kind === "group" ? activeRoom.id : undefined,
      replyTo: replyRef,
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
    setReplyingTo(null);
    setMentionState(null);
    inputRef.current?.focus();

    // If I'm hosting this room and the message starts with @gemini, my own app
    // calls the API (since I have the key) and broadcasts the response.
    if (activeRoom.isHost && /^@gemini\b/i.test(text)) {
      const apiKey = settings.geminiApiKey;
      if (apiKey) {
        handleGeminiRequest(text.replace(/^@gemini\b/i, "").trim(), activeRoom);
      } else {
        showToast("Configura tu API Key de Gemini en ⚙ primero");
      }
    }
  }

  function startReply(m: Msg) {
    if (!activeRoom) return;
    const authorName =
      m.author === "me"
        ? settings.myName
        : (m.authorName ?? activeRoom.memberNames[m.author as string] ?? "?");
    let snippet = (m.text ?? (m.imageDataUrl ? "🖼 imagen" : "")).trim();
    if (snippet.length > 80) snippet = snippet.slice(0, 80) + "…";
    setReplyingTo({ msgId: m.id, authorName, snippet });
    inputRef.current?.focus();
  }

  function handleComposerChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setDraft(value);
    // Detect @ at caret to trigger mention autocomplete (groups only)
    if (activeRoom?.kind === "group") {
      const caret = e.target.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const atIdx = before.lastIndexOf("@");
      if (
        atIdx >= 0 &&
        (atIdx === 0 || /\s/.test(before[atIdx - 1])) &&
        !/\s/.test(before.slice(atIdx + 1))
      ) {
        setMentionState({ query: before.slice(atIdx + 1).toLowerCase(), atIndex: atIdx });
        return;
      }
    }
    setMentionState(null);
  }

  function insertMention(name: string) {
    if (!mentionState) return;
    const before = draft.slice(0, mentionState.atIndex);
    const afterStart = mentionState.atIndex + 1 + mentionState.query.length;
    const after = draft.slice(afterStart);
    const safe = name.replace(/\s+/g, "_");
    const next = `${before}@${safe} ${after}`;
    setDraft(next);
    setMentionState(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        const pos = before.length + safe.length + 2;
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }

  function openMusic(videoId: string) {
    if (!activeRoom || !peerRef.current) return;
    setMusicVideoId(videoId);
    setMusicHostId(peerRef.current.myId);
    setMusicOpen(true);
    const wire: WireMsg = {
      type: "music-open",
      videoId,
      toGroup: activeRoom.kind === "group" ? activeRoom.id : undefined,
      ts: Date.now(),
    };
    if (activeRoom.kind === "dm") {
      const target = activeRoom.memberPeerIds[0];
      if (target) peerRef.current.send(target, wire);
    } else {
      for (const pid of activeRoom.memberPeerIds) peerRef.current.send(pid, wire);
    }
  }

  function closeMusic() {
    if (!activeRoom || !peerRef.current) return;
    setMusicVideoId(null);
    setMusicHostId(null);
    setMusicOpen(false);
    const wire: WireMsg = {
      type: "music-close",
      toGroup: activeRoom.kind === "group" ? activeRoom.id : undefined,
      ts: Date.now(),
    };
    if (activeRoom.kind === "dm") {
      const target = activeRoom.memberPeerIds[0];
      if (target) peerRef.current.send(target, wire);
    } else {
      for (const pid of activeRoom.memberPeerIds) peerRef.current.send(pid, wire);
    }
  }

  function broadcastMusicState(playing: boolean, positionSec: number) {
    if (!activeRoom || !peerRef.current) return;
    const wire: WireMsg = {
      type: "music-state",
      playing,
      positionSec,
      ts: Date.now(),
      toGroup: activeRoom.kind === "group" ? activeRoom.id : undefined,
    };
    if (activeRoom.kind === "dm") {
      const target = activeRoom.memberPeerIds[0];
      if (target) peerRef.current.send(target, wire);
    } else {
      for (const pid of activeRoom.memberPeerIds) peerRef.current.send(pid, wire);
    }
  }

  function sendImageDataUrl(dataUrl: string) {
    if (!activeRoom || !peerRef.current) return;
    const msgId = uid();
    const ts = Date.now();
    const replyRef = replyingTo ?? undefined;
    updateRoom(activeRoom.id, (r) => ({
      ...r,
      messages: [...r.messages, { id: msgId, author: "me", imageDataUrl: dataUrl, ts, replyTo: replyRef }],
    }));
    const wire: WireMsg = {
      type: "image",
      msgId,
      from: peerRef.current.myId,
      fromName: settings.myName,
      imageDataUrl: dataUrl,
      ts,
      toGroup: activeRoom.kind === "group" ? activeRoom.id : undefined,
      replyTo: replyRef,
    };
    if (activeRoom.kind === "dm") {
      const target = activeRoom.memberPeerIds[0];
      if (target) peerRef.current.send(target, wire);
    } else {
      for (const pid of activeRoom.memberPeerIds) peerRef.current.send(pid, wire);
    }
    setReplyingTo(null);
  }

  async function importStickers() {
    try {
      const paths = await open({
        multiple: true,
        filters: [{ name: "Stickers", extensions: ["png", "webp", "gif", "jpg", "jpeg"] }],
      });
      if (!paths) return;
      const arr = Array.isArray(paths) ? paths : [paths];
      const newOnes: Sticker[] = [];
      for (const p of arr) {
        if (typeof p !== "string") continue;
        try {
          const bytes = await readFile(p);
          const ext = p.split(".").pop()?.toLowerCase() ?? "png";
          const mime = ext === "jpg" ? "jpeg" : ext;
          const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
          const dataUrl = `data:image/${mime};base64,${b64}`;
          const name = p.split(/[\\/]/).pop() ?? "sticker";
          newOnes.push({ id: uid(), dataUrl, name });
        } catch (e) {
          console.error("[stickers] failed to read", p, e);
        }
      }
      if (newOnes.length > 0) {
        setStickers((s) => [...s, ...newOnes]);
        showToast(`${newOnes.length} sticker(s) importado(s)`);
      }
    } catch (e) {
      console.error(e);
      showToast("No se pudo importar stickers");
    }
  }

  function deleteSticker(id: string) {
    setStickers((s) => s.filter((x) => x.id !== id));
  }

  function sendSticker(s: Sticker) {
    sendImageDataUrl(s.dataUrl);
    setStickerPickerOpen(false);
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
    if (!confirm("¿Eliminar este chat? También borrará todo el historial guardado.")) return;
    setRooms((rs) => {
      const next = rs.filter((r) => r.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? "");
      return next;
    });
    deleteRoomMessagesFromDb(id).catch((e) => console.warn("[db] delete failed", e));
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

  // Custom tab drag: lets the user drag the window from any tab (they're <button>s
  // so Tauri's data-tauri-drag-region doesn't pick them up). Distinguishes click
  // from drag by a small movement threshold.
  function tabDragHandler(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    function onMove(ev: MouseEvent) {
      if (dragging) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
        dragging = true;
        getCurrentWebviewWindow().startDragging().catch(() => {});
        cleanup();
      }
    }
    function onUp() { cleanup(); }
    function cleanup() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function endCallLocal(reason?: string) {
    const pm = peerRef.current;
    if (pm) pm.stopVoice();
    setVoiceActive(false);
    setMicMuted(false);
    setCameraActive(false);
    setLocalCameraStream(null);
    setCallStartTs(null);
    if (reason) showToast(reason);
  }

  async function toggleVoiceCall() {
    if (!activeRoom || !peerRef.current) return;
    const pm = peerRef.current;
    if (pm.isVoiceActive()) {
      endCallLocal("Llamada finalizada");
      return;
    }
    const targets = activeRoom.memberPeerIds.filter((pid) => pm.isConnected(pid));
    if (targets.length === 0) {
      showToast("Nadie conectado para llamar");
      return;
    }
    try {
      await pm.startVoice(targets);
      setVoiceActive(true);
      setCallStartTs(Date.now());
      showToast(`Llamando a ${targets.length}…`);
    } catch (e: any) {
      console.error(e);
      if (e?.name === "NotAllowedError") {
        showToast("Permiso de micrófono denegado");
      } else {
        showToast(`No se pudo iniciar la llamada: ${e?.message ?? "error"}`);
      }
    }
  }

  function toggleMic() {
    if (!peerRef.current) return;
    const next = !micMuted;
    peerRef.current.setMicMuted(next);
    setMicMuted(next);
    showToast(next ? "Mic silenciado" : "Mic encendido");
  }

  async function acceptIncomingCall() {
    if (!incomingCall || !peerRef.current) return;
    try {
      const myStream = await peerRef.current.ensureVoiceStream();
      incomingCall.accept(myStream);
      setVoiceActive(true);
      setIncomingCall(null);
      showToast("En llamada");
    } catch (e: any) {
      console.error(e);
      if (e?.name === "NotAllowedError") {
        showToast("Permiso de micrófono denegado");
      } else {
        showToast(`No se pudo aceptar: ${e?.message ?? "error"}`);
      }
      incomingCall.reject();
      setIncomingCall(null);
    }
  }

  function rejectIncomingCall() {
    incomingCall?.reject();
    setIncomingCall(null);
    showToast("Llamada rechazada");
  }

  async function toggleCamera() {
    if (!activeRoom || !peerRef.current) return;
    const pm = peerRef.current;
    if (pm.isCameraActive()) {
      pm.stopCamera();
      setCameraActive(false);
      setLocalCameraStream(null);
      return;
    }
    if (!voiceActive) {
      showToast("Inicia la llamada primero");
      return;
    }
    const targets = activeRoom.memberPeerIds.filter((pid) => pm.isConnected(pid));
    try {
      const stream = await pm.startCamera(targets);
      setCameraActive(true);
      setLocalCameraStream(stream);
    } catch (e: any) {
      console.error(e);
      if (e?.name === "NotAllowedError") {
        showToast("Permiso de cámara denegado");
      } else {
        showToast(`Error con la cámara: ${e?.message ?? "error"}`);
      }
    }
  }

  // When a new peer connects to a room where we're already in a voice call,
  // automatically include them in the call.
  useEffect(() => {
    if (!voiceActive || !peerRef.current || !activeRoom) return;
    const pm = peerRef.current;
    for (const pid of activeRoom.memberPeerIds) {
      if (pm.isConnected(pid)) {
        pm.placeVoiceCall(pid);
        if (cameraActive) pm.placeCameraCall(pid);
      }
    }
  }, [voiceActive, cameraActive, activeRoom, rooms]);

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
  const sidebarOn = !!settings.sidebarMode;
  return (
    <div className={`app ${focused ? "focused" : "blurred"} ${immersivePeerId ? "immersive-mode" : ""} ${sidebarOn ? "with-sidebar" : ""}`}>
      {sidebarOn && (
        <aside className="sidebar">
          <div className="sidebar-head">Chati</div>
          <div className="sidebar-list">
            {rooms.map((r) => {
              const st = peerStatus(r.id);
              const allOn = st.total > 0 && st.connected === st.total;
              const u = unread[r.id] ?? 0;
              return (
                <button
                  key={r.id}
                  className={`sidebar-item ${r.id === activeId ? "active" : ""} ${u > 0 ? "has-unread" : ""}`}
                  onClick={() => setActiveId(r.id)}
                  onAuxClick={(e) => { if (e.button === 1) removeRoom(r.id); }}
                  title={`${r.kind === "group" ? "Grupo · " : ""}${st.connected}/${st.total} conectados`}
                >
                  <span className={`dot ${allOn ? "on" : "off"}`} />
                  <span className="sidebar-name">{r.name}</span>
                  {u > 0 && <span className="unread-badge">{u > 9 ? "9+" : u}</span>}
                </button>
              );
            })}
            {[...incomingRequests.entries()].map(([peerId, name]) => (
              <button
                key={`req-${peerId}`}
                className={`sidebar-item sidebar-request ${activeId === `req-${peerId}` ? "active" : ""}`}
                onClick={() => setActiveId(`req-${peerId}`)}
              >
                <span className="dot pulse" />
                <span className="sidebar-name">{name} ?</span>
              </button>
            ))}
            <button className="sidebar-add" onClick={() => setNewRoomOpen(true)}>+ Nuevo</button>
          </div>
        </aside>
      )}
      <header className="topbar" data-tauri-drag-region>
        {!sidebarOn && <div className="tabs">
          {rooms.map((r) => {
            const st = peerStatus(r.id);
            const allOn = st.total > 0 && st.connected === st.total;
            const u = unread[r.id] ?? 0;
            return (
              <button
                key={r.id}
                className={`tab ${r.id === activeId ? "active" : ""} ${u > 0 ? "has-unread" : ""}`}
                onMouseDown={tabDragHandler}
                onClick={() => setActiveId(r.id)}
                onAuxClick={(e) => { if (e.button === 1) removeRoom(r.id); }}
                title={`${r.kind === "group" ? "Grupo · " : ""}${st.connected}/${st.total} conectados · arrastra para mover ventana · click medio para eliminar`}
              >
                <span className={`dot ${allOn ? "on" : "off"}`} />
                <span className="tab-name">{r.name}</span>
                {u > 0 && <span className="unread-badge">{u > 9 ? "9+" : u}</span>}
              </button>
            );
          })}
          {[...incomingRequests.entries()].map(([peerId, name]) => (
            <button
              key={`req-${peerId}`}
              className={`tab tab-request ${activeId === `req-${peerId}` ? "active" : ""}`}
              onMouseDown={tabDragHandler}
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
        </div>}
        {sidebarOn && activeRoom && (
          <div className="topbar-title" data-tauri-drag-region>
            {activeRoom.name}
          </div>
        )}
        <div className="topbar-spacer" data-tauri-drag-region title="Arrastra aquí para mover" />
        <div className="winctl">
          <button className="winbtn" onClick={() => setActivityOpen((v) => !v)} title="Actividad reciente">🔔</button>
          <button className="winbtn" onClick={() => setCmdPaletteOpen(true)} title="Buscador (Ctrl+K)">⌕</button>
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
          {voiceActive && (() => {
            // Pill showing who you're currently on a call with (in this room).
            const peersInCall = activeRoom.memberPeerIds.filter(
              (pid) => peerRef.current?.isConnected(pid),
            );
            const names = peersInCall.map((pid) => activeRoom.memberNames[pid] ?? pid.slice(0, 8));
            return (
              <div className="call-status">
                <span className="call-status-dot" />
                <span className="call-status-text">
                  En llamada con <b>{names.join(", ") || "(esperando)"}</b>
                  {cameraActive && " · cámara"}
                  {micMuted && " · silenciado"}
                </span>
              </div>
            );
          })()}

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
                    <button className="msg-reply-btn" title="Responder" onClick={() => startReply(m)}>↩</button>
                    {m.replyTo && (
                      <div className="quoted">
                        <span className="quoted-author">{m.replyTo.authorName}</span>
                        <span className="quoted-snippet">{m.replyTo.snippet}</span>
                      </div>
                    )}
                    {m.author !== "me" && activeRoom.kind === "group" && (
                      <span className="msg-author">{m.authorName ?? activeRoom.memberNames[m.author as string] ?? "?"}</span>
                    )}
                    {m.text && <MessageText text={m.text} myName={settings.myName} />}
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
            <button className="iconbtn" onClick={attachImage} title="Adjuntar imagen" disabled={!peerReady}>
              <Icon name="image" />
            </button>
            <button className="iconbtn" onClick={() => setStickerPickerOpen(true)} title="Stickers" disabled={!peerReady}>
              <Icon name="sticker" />
            </button>
            <button
              className={`iconbtn ${isSharing ? "is-on" : ""}`}
              onClick={toggleScreenShare}
              title={isSharing ? "Dejar de compartir pantalla" : "Compartir pantalla (con audio del sistema)"}
              disabled={!peerReady}
            >
              <Icon name={isSharing ? "monitor-off" : "monitor"} />
            </button>
            <button
              className={`iconbtn ${voiceActive ? "is-on" : ""}`}
              onClick={toggleVoiceCall}
              title={voiceActive ? "Colgar llamada" : "Iniciar llamada de voz"}
              disabled={!peerReady}
            >
              <Icon name={voiceActive ? "phone-off" : "phone"} />
            </button>
            <button
              className="iconbtn"
              onClick={() => setMusicPickerOpen(true)}
              title="Reproducir YouTube juntos"
              disabled={!peerReady}
            >
              <Icon name="music" />
            </button>
            {voiceActive && (
              <button
                className={`iconbtn ${micMuted ? "is-on" : ""}`}
                onClick={toggleMic}
                title={micMuted ? "Activar micrófono" : "Silenciar micrófono"}
              >
                <Icon name={micMuted ? "mic-off" : "mic"} />
              </button>
            )}
            {voiceActive && (
              <button
                className={`iconbtn ${cameraActive ? "is-on" : ""}`}
                onClick={toggleCamera}
                title={cameraActive ? "Apagar cámara" : "Encender cámara"}
              >
                {/* Discord/Zoom convention: slash = off, no slash = on/active */}
                <Icon name={cameraActive ? "cam" : "cam-off"} />
              </button>
            )}
            <div className="composer-input-wrap">
              {replyingTo && (
                <div className="reply-preview">
                  <span className="reply-bar" />
                  <div className="reply-body">
                    <span className="reply-author">↩ Respondiendo a {replyingTo.authorName}</span>
                    <span className="reply-snippet">{replyingTo.snippet}</span>
                  </div>
                  <button className="reply-cancel" onClick={() => setReplyingTo(null)} title="Cancelar respuesta">✕</button>
                </div>
              )}
              {mentionState && activeRoom?.kind === "group" && (
                <MentionDropdown
                  query={mentionState.query}
                  candidates={Object.values(activeRoom.memberNames)}
                  onPick={insertMention}
                />
              )}
              <textarea
                ref={inputRef}
                className="input"
                placeholder={peerReady ? (activeRoom?.kind === "group" ? "Mensaje (@ para mencionar)…" : "Mensaje (Ctrl+V pega imagen)…") : "Conectando…"}
                value={draft}
                onChange={handleComposerChange}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && replyingTo) { e.preventDefault(); setReplyingTo(null); return; }
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
                }}
                rows={1}
                disabled={!peerReady}
              />
            </div>
            <button className="iconbtn send" onClick={sendText} title="Enviar (Enter)" disabled={!peerReady}>
              <Icon name="send" />
            </button>
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

          <hr />
          <div className="section-title">Layout</div>
          <label className="row toggle">
            <span title="Lista de chats en barra vertical lateral (en lugar de pestañas arriba)">
              Sidebar vertical
            </span>
            <input
              type="checkbox"
              checked={!!settings.sidebarMode}
              onChange={(e) => setSettings((s) => ({ ...s, sidebarMode: e.target.checked }))}
            />
          </label>

          <hr />
          <div className="section-title">Asistente AI (Gemini)</div>
          <div className="hint" style={{ textAlign: "left", marginBottom: 4 }}>
            Si pegas tu API Key de Google AI, cualquier miembro del chat podrá invocar a Gemini escribiendo <code>@gemini</code> al inicio del mensaje. La respuesta se ve para todos.
          </div>
          <label className="row">
            <span>API Key</span>
            <input
              type="password"
              className="thininput"
              value={settings.geminiApiKey ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, geminiApiKey: e.target.value }))}
              placeholder="AIza…"
            />
          </label>
          {settings.geminiApiKey && (
            <div className="hint" style={{ color: "#8ee9ad" }}>✓ Activo en tus chats donde seas host</div>
          )}

          <hr />
          <div className="section-title">Conexión</div>
          <div className="row">
            <span>Estado</span>
            <span className="row-code">
              {peerReady ? "🟢 conectado a PeerJS" : "⚪ conectando…"}
            </span>
          </div>
          <button
            className="danger-btn"
            style={{ background: "rgba(74,140,255,0.12)", borderColor: "rgba(74,140,255,0.35)", color: "#9ec3ff" }}
            onClick={forceReconnectAll}
            disabled={!peerReady}
          >
            🔄 Reconectar a contactos
          </button>

          <hr />
          <div className="section-title">Atajo global</div>
          <div className="row">
            <span>Mostrar/ocultar</span>
            <code className="row-code">{settings.toggleShortcut ?? "Ctrl+Shift+H"}</code>
            <button className="linkbtn" onClick={() => setHotkeyEditorOpen(true)}>Cambiar</button>
          </div>
          <div className="hint">
            (También apaga click-a-través al mostrar)
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

      {/* Floating call popup with timer + hangup */}
      {voiceActive && activeRoom && (() => {
        const peersInCall = activeRoom.memberPeerIds.filter((pid) => peerRef.current?.isConnected(pid));
        const names = peersInCall.map((pid) => activeRoom.memberNames[pid] ?? pid.slice(0, 8));
        const elapsedMs = callStartTs ? Date.now() - callStartTs : 0;
        const mins = Math.floor(elapsedMs / 60000);
        const secs = Math.floor((elapsedMs % 60000) / 1000);
        const time = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        const _ = callTick; // ensure re-render on tick
        void _;
        return (
          <div className="call-popup">
            <span className="call-popup-dot" />
            <span className="call-popup-text">
              Llamada con <b>{names.join(", ") || "(esperando)"}</b>
            </span>
            <span className="call-popup-time">{time}</span>
            <button
              className="call-popup-hangup"
              onClick={() => endCallLocal("Llamada finalizada")}
              title="Colgar"
            >
              <Icon name="phone-off" size={13} />
            </button>
          </div>
        );
      })()}

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
                <button className="iconbtn" onClick={attachImage} title="Adjuntar imagen" disabled={!peerReady}>
                  <Icon name="image" />
                </button>
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
                <button className="iconbtn send" onClick={sendText} disabled={!peerReady} title="Enviar (Enter)">
                  <Icon name="send" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {lightboxImage && (
        <Lightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />
      )}

      {/* Hidden audio elements for incoming voice streams — the browser auto-mixes them. */}
      {[...remoteVoiceStreams.entries()].map(([pid, stream]) => (
        <AudioPlayer key={pid} stream={stream} />
      ))}

      {/* Floating call panel — local cam + remote cams during a voice call */}
      {voiceActive && (cameraActive || remoteCameraStreams.size > 0) && (
        <div className="call-tiles">
          {localCameraStream && (
            <div className="call-tile call-tile-self">
              <LocalVideoPreview stream={localCameraStream} />
              <span className="call-tile-label">Tú</span>
            </div>
          )}
          {[...remoteCameraStreams.entries()].map(([pid, stream]) => {
            const name =
              rooms.find((r) => r.memberPeerIds.includes(pid))?.memberNames[pid]
              ?? pid.slice(0, 8);
            return (
              <div className="call-tile" key={pid}>
                <VideoTile stream={stream} />
                <span className="call-tile-label">{name}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Incoming call modal */}
      {incomingCall && (
        <div className="modal-backdrop" onClick={rejectIncomingCall}>
          <div className="modal call-incoming" onClick={(e) => e.stopPropagation()}>
            <div className="call-incoming-icon">📞</div>
            <div className="call-incoming-title"><b>{incomingCallName}</b> te está llamando</div>
            <div className="modal-actions">
              <button className="secondary call-reject" onClick={rejectIncomingCall}>Rechazar</button>
              <button className="primary call-accept" onClick={acceptIncomingCall}>Aceptar</button>
            </div>
          </div>
        </div>
      )}

      {musicPickerOpen && (
        <MusicPicker
          onClose={() => setMusicPickerOpen(false)}
          onPick={(vid) => { setMusicPickerOpen(false); openMusic(vid); }}
        />
      )}

      {stickerPickerOpen && (
        <StickerPicker
          stickers={stickers}
          onPick={sendSticker}
          onImport={importStickers}
          onDelete={deleteSticker}
          onClose={() => setStickerPickerOpen(false)}
        />
      )}

      {hotkeyEditorOpen && (
        <HotkeyEditor
          current={settings.toggleShortcut ?? "Ctrl+Shift+H"}
          onSave={applyNewShortcut}
          onClose={() => setHotkeyEditorOpen(false)}
        />
      )}

      {cmdPaletteOpen && (
        <CommandPalette
          rooms={rooms}
          onClose={() => setCmdPaletteOpen(false)}
          onPickRoom={(id) => { setActiveId(id); setCmdPaletteOpen(false); }}
          onCommand={(cmd) => {
            setCmdPaletteOpen(false);
            switch (cmd) {
              case "settings": setSettingsOpen(true); break;
              case "newchat": setNewRoomOpen(true); break;
              case "reconnect": forceReconnectAll(); break;
              case "sidebar": setSettings((s) => ({ ...s, sidebarMode: !s.sidebarMode })); break;
              case "update": manualCheck(); break;
              case "hide": hideWindow(); break;
            }
          }}
        />
      )}

      {activityOpen && (
        <ActivityFeed
          items={activity}
          rooms={rooms}
          onPickRoom={(id) => { setActiveId(id); setActivityOpen(false); }}
          onClose={() => setActivityOpen(false)}
        />
      )}

      {musicOpen && musicVideoId && activeRoom && (
        <YouTubePlayer
          videoId={musicVideoId}
          isHost={musicHostId === myPeerId}
          onClose={closeMusic}
          onBroadcastState={broadcastMusicState}
        />
      )}

      {msgNotif && msgNotif.roomId !== activeId && (
        <div
          className="msg-notif"
          onClick={() => { setActiveId(msgNotif.roomId); setMsgNotif(null); }}
          title="Click para ver el chat"
        >
          <span className="msg-notif-author">{msgNotif.author}</span>
          <span className="msg-notif-preview">{msgNotif.preview}</span>
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
// Renders text with @mentions highlighted. A mention pointing at the local user
// is styled even more prominently.
function MessageText({ text, myName }: { text: string; myName: string }) {
  const mySafe = myName.replace(/\s+/g, "_").toLowerCase();
  const parts = text.split(/(@\w+)/g);
  return (
    <span className="msg-text">
      {parts.map((part, i) => {
        if (part.startsWith("@") && part.length > 1) {
          const target = part.slice(1).toLowerCase();
          const isMe = target === mySafe;
          return (
            <span key={i} className={`mention ${isMe ? "mention-me" : ""}`}>
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function MentionDropdown({
  query,
  candidates,
  onPick,
}: {
  query: string;
  candidates: string[];
  onPick: (name: string) => void;
}) {
  const filtered = candidates
    .filter((c) => c && c.toLowerCase().includes(query))
    .slice(0, 5);
  if (filtered.length === 0) return null;
  return (
    <div className="mention-dropdown">
      {filtered.map((name) => (
        <button key={name} className="mention-item" onMouseDown={(e) => { e.preventDefault(); onPick(name); }}>
          @{name}
        </button>
      ))}
    </div>
  );
}

function MusicPicker({ onClose, onPick }: { onClose: () => void; onPick: (videoId: string) => void }) {
  const [url, setUrl] = useState("");
  function submit() {
    const id = parseYouTubeId(url);
    if (!id) return;
    onPick(id);
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Escuchar/ver YouTube juntos</span>
          <button className="winbtn" onClick={onClose}>×</button>
        </div>
        <label className="modal-row">
          <span>Pega un link de YouTube</span>
          <input
            autoFocus
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={submit} disabled={!parseYouTubeId(url)}>
            Reproducir para todos
          </button>
        </div>
        <div className="hint">
          Todos en este chat verán el video y las acciones del que lo abrió (play/pause) se replican.
        </div>
      </div>
    </div>
  );
}

function parseYouTubeId(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Direct 11-char ID
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace(/^\//, "").slice(0, 11);
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /embed/ID or /shorts/ID
      const m = u.pathname.match(/\/(embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    // not a URL
  }
  return null;
}

// Globally load the YouTube IFrame API once. Returns a promise resolving to YT global.
let ytApiPromise: Promise<any> | null = null;
function loadYouTubeApi(): Promise<any> {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const w = window as any;
    if (w.YT && w.YT.Player) { resolve(w.YT); return; }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    w.onYouTubeIframeAPIReady = () => resolve((window as any).YT);
  });
  return ytApiPromise;
}

function YouTubePlayer({
  videoId,
  isHost,
  onClose,
  onBroadcastState,
}: {
  videoId: string;
  isHost: boolean;
  onClose: () => void;
  onBroadcastState: (playing: boolean, positionSec: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const lastBroadcast = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let player: any = null;
    loadYouTubeApi().then((YT) => {
      if (cancelled || !containerRef.current) return;
      player = new YT.Player(containerRef.current, {
        videoId,
        playerVars: { autoplay: 1, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => {
            playerRef.current = player;
          },
          onStateChange: (e: any) => {
            if (!isHost) return;
            const now = Date.now();
            if (now - lastBroadcast.current < 250) return;
            lastBroadcast.current = now;
            const playing = e.data === 1; // 1 = playing
            const pos = player.getCurrentTime?.() ?? 0;
            // Only broadcast on play/pause edges
            if (e.data === 1 || e.data === 2) {
              onBroadcastState(playing, pos);
            }
          },
        },
      });
    });
    return () => {
      cancelled = true;
      try { playerRef.current?.destroy?.(); } catch { /* ignore */ }
    };
  }, [videoId]);

  // Listen for sync messages from the host (when we're not host).
  useEffect(() => {
    if (isHost) return;
    function onSync(e: Event) {
      const detail = (e as CustomEvent).detail as { playing: boolean; positionSec: number };
      const p = playerRef.current;
      if (!p) return;
      try {
        const cur = p.getCurrentTime?.() ?? 0;
        if (Math.abs(cur - detail.positionSec) > 1.5) {
          p.seekTo(detail.positionSec, true);
        }
        if (detail.playing) p.playVideo();
        else p.pauseVideo();
      } catch { /* ignore */ }
    }
    window.addEventListener("yt-sync-state", onSync);
    return () => window.removeEventListener("yt-sync-state", onSync);
  }, [isHost]);

  // Host: periodically broadcast position to keep peers in sync.
  useEffect(() => {
    if (!isHost) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        const state = p.getPlayerState?.();
        const pos = p.getCurrentTime?.() ?? 0;
        onBroadcastState(state === 1, pos);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(id);
  }, [isHost, onBroadcastState]);

  return (
    <div className="yt-overlay">
      <div className="yt-frame-wrap">
        <div ref={containerRef} className="yt-frame" />
        <div className="yt-hud">
          <span>🎵 YouTube {isHost ? "(host)" : ""}</span>
          {isHost && <button className="rv-btn" onClick={onClose}>cerrar para todos</button>}
          {!isHost && <button className="rv-btn" onClick={onClose}>cerrar (solo mío)</button>}
        </div>
      </div>
    </div>
  );
}

function CommandPalette({
  rooms,
  onClose,
  onPickRoom,
  onCommand,
}: {
  rooms: Room[];
  onClose: () => void;
  onPickRoom: (id: string) => void;
  onCommand: (cmd: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  type Result = { kind: "room" | "msg" | "cmd"; id: string; label: string };
  const commands: Result[] = [
    { kind: "cmd", id: "newchat", label: "+ Nuevo chat o grupo" },
    { kind: "cmd", id: "settings", label: "⚙ Abrir ajustes" },
    { kind: "cmd", id: "reconnect", label: "🔄 Reconectar a contactos" },
    { kind: "cmd", id: "sidebar", label: "↔ Cambiar layout (tabs / sidebar)" },
    { kind: "cmd", id: "update", label: "⬇ Buscar nueva versión" },
    { kind: "cmd", id: "hide", label: "👻 Ocultar ventana (Ctrl+Shift+H)" },
  ];
  const q = query.toLowerCase();
  const roomMatches: Result[] = rooms
    .filter((r) => r.name.toLowerCase().includes(q))
    .slice(0, 6)
    .map((r) => ({ kind: "room", id: r.id, label: `💬 ${r.name}` }));
  const msgMatches: Result[] = q.length > 1
    ? rooms.flatMap((r) =>
        r.messages
          .filter((m) => m.text && m.text.toLowerCase().includes(q))
          .slice(-5)
          .map((m) => ({
            kind: "msg" as const,
            id: r.id,
            label: `🔍 [${r.name}] ${(m.text ?? "").slice(0, 60)}`,
          })),
      ).slice(0, 6)
    : [];
  const cmdMatches: Result[] = commands.filter((c) => c.label.toLowerCase().includes(q));
  const results: Result[] = [...roomMatches, ...msgMatches, ...cmdMatches];

  function activate(i: number) {
    const r = results[i];
    if (!r) return;
    if (r.kind === "room" || r.kind === "msg") onPickRoom(r.id);
    else onCommand(r.id);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder="Buscar chats, mensajes o comandos…  (Ctrl+K)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
        />
        <div className="cmd-results">
          {results.length === 0 && <div className="cmd-empty">Sin resultados</div>}
          {results.map((r, i) => (
            <button
              key={`${r.kind}-${r.id}-${i}`}
              className={`cmd-result ${i === sel ? "selected" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => activate(i)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActivityFeed({
  items,
  rooms,
  onPickRoom,
  onClose,
}: {
  items: ActivityItem[];
  rooms: Room[];
  onPickRoom: (id: string) => void;
  onClose: () => void;
}) {
  function timeAgo(ts: number) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }
  return (
    <div className="activity-panel" onClick={(e) => e.stopPropagation()}>
      <div className="activity-head">
        <span>Actividad</span>
        <button className="winbtn" onClick={onClose}>×</button>
      </div>
      <div className="activity-list">
        {items.length === 0 && <div className="cmd-empty">Sin actividad reciente</div>}
        {items.map((it) => {
          const room = it.roomId ? rooms.find((r) => r.id === it.roomId) : null;
          return (
            <button
              key={it.id}
              className={`activity-item activity-${it.kind}`}
              onClick={() => { if (room) onPickRoom(room.id); else onClose(); }}
            >
              <div className="activity-text">{it.text}</div>
              <div className="activity-meta">{timeAgo(it.ts)}{room ? ` · ${room.name}` : ""}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HotkeyEditor({
  current,
  onSave,
  onClose,
}: {
  current: string;
  onSave: (combo: string) => void;
  onClose: () => void;
}) {
  const [mods, setMods] = useState<Set<string>>(new Set());
  const [mainKey, setMainKey] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Only handle while modal is open and ONLY keyboard. We deliberately don't
      // listen for mouse events to avoid accidentally binding the click that
      // confirms the dialog.
      e.preventDefault();
      e.stopPropagation();
      const m = new Set<string>();
      if (e.ctrlKey) m.add("Ctrl");
      if (e.shiftKey) m.add("Shift");
      if (e.altKey) m.add("Alt");
      if (e.metaKey) m.add("Meta");

      const k = e.key;
      // Ignore plain modifier presses — they're not a complete combo.
      if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") {
        setMods(m);
        return;
      }
      // Map JS key strings to Tauri accelerator format.
      let mapped: string | null = null;
      if (k.length === 1 && /[a-zA-Z]/.test(k)) mapped = k.toUpperCase();
      else if (k.length === 1 && /[0-9]/.test(k)) mapped = k;
      else if (/^F([1-9]|1[0-2])$/.test(k)) mapped = k; // F1-F12
      else if (k === " ") mapped = "Space";
      else if (k === "Enter") mapped = "Enter";
      else if (k === "Tab") mapped = "Tab";
      else if (k === "Escape") {
        // Escape closes the editor instead of binding
        onClose();
        return;
      }
      else if (k.startsWith("Arrow")) {
        mapped = k.replace("Arrow", "");
      }
      if (mapped) {
        setMods(m);
        setMainKey(mapped);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const combo = mainKey ? [...mods, mainKey].join("+") : "";
  const isValid = !!mainKey && mods.size > 0;

  function accept() {
    if (!isValid) return;
    onSave(combo);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal hotkey-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Cambiar atajo</span>
          <button className="winbtn" onClick={onClose}>×</button>
        </div>
        <div className="hotkey-current">
          <span className="hotkey-label">Atajo actual:</span>
          <code>{current}</code>
        </div>
        <div className="hotkey-capture">
          <div className="hint" style={{ marginBottom: 6 }}>
            Presiona la combinación que quieras (necesita al menos un modificador: Ctrl / Shift / Alt).
          </div>
          <div className={`hotkey-combo ${isValid ? "valid" : ""}`}>
            {combo || "esperando…"}
          </div>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancelar</button>
          <button
            className="primary"
            disabled={!isValid}
            onClick={accept}
          >
            Aceptar
          </button>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          Esc cancela. Solo se captura teclado — los clicks del mouse no se registran.
        </div>
      </div>
    </div>
  );
}

function StickerPicker({
  stickers,
  onPick,
  onImport,
  onDelete,
  onClose,
}: {
  stickers: Sticker[];
  onPick: (s: Sticker) => void;
  onImport: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="sticker-backdrop" onClick={onClose}>
      <div className="sticker-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sticker-head">
          <span>Stickers ({stickers.length})</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="linkbtn" onClick={onImport}>+ importar</button>
            <button className="winbtn" onClick={onClose}>×</button>
          </div>
        </div>
        {stickers.length === 0 ? (
          <div className="sticker-empty">
            <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 8 }}>
              Aún no tienes stickers
            </div>
            <button className="primary" onClick={onImport}>Importar imágenes</button>
            <div className="hint" style={{ marginTop: 8 }}>
              Soporta .webp .png .gif .jpg<br />
              Para WhatsApp: guarda el sticker como imagen desde la app, después impórtalo aquí.
            </div>
          </div>
        ) : (
          <div className="sticker-grid">
            {stickers.map((s) => (
              <div key={s.id} className="sticker-item" title={s.name}>
                <img src={s.dataUrl} alt="" onClick={() => onPick(s)} />
                <button
                  className="sticker-delete"
                  onClick={(e) => { e.stopPropagation(); if (confirm("¿Eliminar este sticker?")) onDelete(s.id); }}
                  title="Eliminar"
                >×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AudioPlayer({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: "none" }} />;
}

function VideoTile({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted />;
}

function LocalVideoPreview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  // Mirror like a typical webcam preview
  return <video ref={ref} autoPlay playsInline muted style={{ transform: "scaleX(-1)" }} />;
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });

  function handleWheel(e: React.WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    setZoom((z) => {
      const next = Math.max(1, Math.min(10, z * factor));
      if (next === 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
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

  return (
    <div className="lightbox-backdrop" onClick={onClose} onWheel={handleWheel}>
      <img
        className="lightbox-img"
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "default",
          transition: dragging ? "none" : "transform 0.05s linear",
        }}
        draggable={false}
      />
      {zoom > 1 && (
        <button
          className="zoom-reset"
          onClick={(e) => { e.stopPropagation(); setZoom(1); setOffset({ x: 0, y: 0 }); }}
        >
          {Math.round(zoom * 100)}% · reset
        </button>
      )}
      <button className="lightbox-close" onClick={onClose} title="Cerrar (Esc)">✕</button>
      <div className="lightbox-hint">Ctrl+rueda: zoom · arrastra: mover</div>
    </div>
  );
}

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
