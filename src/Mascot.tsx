import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";

type NotifPayload = { author: string; preview: string; roomId?: string };

function darken(hex: string, amount = 0.6): string {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const d = (c: number) => Math.max(0, Math.min(255, Math.floor(c * amount)));
  return `#${[d(r), d(g), d(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export default function Mascot() {
  const [bubble, setBubble] = useState<{ author: string; expires: number } | null>(null);
  const [active, setActive] = useState(false);
  const [opacity, setOpacity] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem("mascot.opacity") ?? "1");
    return Number.isFinite(v) ? v : 1;
  });
  const [color, setColor] = useState<string>(() => localStorage.getItem("mascot.color") ?? "#a78bfa");
  const lastRoomId = useRef<string | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    listen<NotifPayload>("mascot:notify", (e) => {
      lastRoomId.current = e.payload.roomId ?? null;
      setBubble({ author: e.payload.author, expires: Date.now() + 5500 });
      setActive(true);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setActive(false), 5500);
    }).then((u) => unlistens.push(u));
    listen<number>("mascot:opacity", (e) => {
      setOpacity(e.payload);
      localStorage.setItem("mascot.opacity", String(e.payload));
    }).then((u) => unlistens.push(u));
    listen<string>("mascot:color", (e) => {
      setColor(e.payload);
      localStorage.setItem("mascot.color", e.payload);
    }).then((u) => unlistens.push(u));
    return () => unlistens.forEach((u) => u());
  }, []);

  useEffect(() => {
    if (!bubble) return;
    const remaining = bubble.expires - Date.now();
    const t = setTimeout(() => setBubble(null), Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [bubble]);

  const downAt = useRef(0);
  const downPos = useRef({ x: 0, y: 0 });
  function onMouseDown(e: React.MouseEvent) {
    downAt.current = Date.now();
    downPos.current = { x: e.clientX, y: e.clientY };
  }
  function onMouseUp(e: React.MouseEvent) {
    const dur = Date.now() - downAt.current;
    const dx = e.clientX - downPos.current.x;
    const dy = e.clientY - downPos.current.y;
    const moved = Math.hypot(dx, dy);
    // Quick click without much movement = open chat
    if (dur < 350 && moved < 6 && lastRoomId.current) {
      emit("mascot:open-chat", { roomId: lastRoomId.current }).catch(() => {});
    }
  }

  const dark = darken(color, 0.65);

  return (
    <div
      className={`mascot-root ${active ? "active" : "peeking"}`}
      style={{ opacity }}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    >
      {bubble && active && (
        <div className="speech-bubble">
          <span>👋 {bubble.author}</span>
        </div>
      )}
      <div className="mascot-body" data-tauri-drag-region>
        {active ? <FullMascot color={color} dark={dark} /> : <PeekingMascot color={color} dark={dark} />}
      </div>
    </div>
  );
}

function FullMascot({ color, dark }: { color: string; dark: string }) {
  return (
    <svg viewBox="0 0 100 130" width="86" height="110" style={{ pointerEvents: "none" }}>
      {/* shadow */}
      <ellipse cx="50" cy="122" rx="24" ry="3" fill="rgba(0,0,0,0.35)" />
      {/* legs - animated wobble */}
      <g className="mascot-legs">
        <ellipse cx="40" cy="108" rx="5" ry="7" fill={dark} />
        <ellipse cx="60" cy="108" rx="5" ry="7" fill={dark} />
        {/* feet */}
        <ellipse cx="40" cy="116" rx="7" ry="3" fill={darken(dark, 0.75)} />
        <ellipse cx="60" cy="116" rx="7" ry="3" fill={darken(dark, 0.75)} />
      </g>
      {/* body */}
      <ellipse cx="50" cy="82" rx="22" ry="14" fill={dark} />
      {/* head */}
      <circle cx="50" cy="45" r="30" fill={color} />
      {/* ear tufts */}
      <path d="M22 32 Q 18 16 32 22 Z" fill={color} />
      <path d="M78 32 Q 82 16 68 22 Z" fill={color} />
      <path d="M24 28 Q 22 20 30 24 Z" fill={dark} />
      <path d="M76 28 Q 78 20 70 24 Z" fill={dark} />
      {/* eyes whites */}
      <circle cx="40" cy="44" r="6" fill="white" />
      <circle cx="60" cy="44" r="6" fill="white" />
      {/* pupils */}
      <circle cx="41" cy="45" r="2.6" fill="#1a1a2e" />
      <circle cx="61" cy="45" r="2.6" fill="#1a1a2e" />
      <circle cx="42" cy="43" r="0.8" fill="white" />
      <circle cx="62" cy="43" r="0.8" fill="white" />
      {/* cheeks */}
      <circle cx="30" cy="52" r="3.5" fill="#f9a8d4" opacity="0.7" />
      <circle cx="70" cy="52" r="3.5" fill="#f9a8d4" opacity="0.7" />
      {/* smile */}
      <path d="M 42 55 Q 50 62 58 55" stroke="#1a1a2e" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* waving hand */}
      <g className="mascot-hand">
        <ellipse cx="83" cy="48" rx="8" ry="6" fill={color} />
        <ellipse cx="83" cy="48" rx="4" ry="3" fill="#f9a8d4" opacity="0.5" />
      </g>
    </svg>
  );
}

function PeekingMascot({ color, dark }: { color: string; dark: string }) {
  return (
    <svg viewBox="0 0 100 70" width="86" height="60" style={{ pointerEvents: "none" }}>
      <ellipse cx="50" cy="66" rx="18" ry="2" fill="rgba(0,0,0,0.25)" />
      <path d="M 22 50 Q 22 14 50 14 Q 78 14 78 50 Z" fill={color} />
      <path d="M22 32 Q 18 16 32 22 Z" fill={color} />
      <path d="M78 32 Q 82 16 68 22 Z" fill={color} />
      <circle cx="40" cy="40" r="6" fill="white" />
      <circle cx="60" cy="40" r="6" fill="white" />
      <circle cx="41" cy="41" r="2.6" fill="#1a1a2e" />
      <circle cx="61" cy="41" r="2.6" fill="#1a1a2e" />
      <circle cx="42" cy="39" r="0.8" fill="white" />
      <circle cx="62" cy="39" r="0.8" fill="white" />
      {/* hands gripping the bottom edge */}
      <g>
        <ellipse cx="22" cy="50" rx="10" ry="5" fill={color} />
        <ellipse cx="78" cy="50" rx="10" ry="5" fill={color} />
        <circle cx="17" cy="48" r="2" fill={dark} />
        <circle cx="22" cy="47" r="2" fill={dark} />
        <circle cx="27" cy="48" r="2" fill={dark} />
        <circle cx="73" cy="48" r="2" fill={dark} />
        <circle cx="78" cy="47" r="2" fill={dark} />
        <circle cx="83" cy="48" r="2" fill={dark} />
      </g>
    </svg>
  );
}
