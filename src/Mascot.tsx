import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";

type NotifPayload = { author: string; preview: string; roomId?: string };

export default function Mascot() {
  const [bubble, setBubble] = useState<{ author: string; expires: number } | null>(null);
  const [active, setActive] = useState(false);
  const [opacity, setOpacity] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem("mascot.opacity") ?? "1");
    return Number.isFinite(v) ? v : 1;
  });
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
    return () => unlistens.forEach((u) => u());
  }, []);

  useEffect(() => {
    if (!bubble) return;
    const remaining = bubble.expires - Date.now();
    const t = setTimeout(() => setBubble(null), Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [bubble]);

  // Distinguish a click from a drag — Tauri drag-region absorbs mousedown,
  // so we use mouseup time as a rough proxy: short duration = click.
  const downAt = useRef(0);
  function onMouseDown() { downAt.current = Date.now(); }
  function onMouseUp() {
    const dur = Date.now() - downAt.current;
    if (dur < 200 && lastRoomId.current) {
      // Quick click → ask the main window to open the relevant chat.
      emit("mascot:open-chat", { roomId: lastRoomId.current }).catch(() => {});
    }
  }

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
      <div className={`mascot-body ${active ? "wave" : "idle"}`} data-tauri-drag-region>
        {active ? <FullMascot /> : <PeekingMascot />}
      </div>
    </div>
  );
}

function FullMascot() {
  return (
    <svg viewBox="0 0 100 110" width="86" height="95" style={{ pointerEvents: "none" }}>
      <ellipse cx="50" cy="102" rx="22" ry="3" fill="rgba(0,0,0,0.35)" />
      <ellipse cx="50" cy="78" rx="22" ry="14" fill="#6b46c1" />
      <circle cx="50" cy="45" r="30" fill="#a78bfa" />
      <path d="M22 32 Q 18 16 32 22 Z" fill="#a78bfa" />
      <path d="M78 32 Q 82 16 68 22 Z" fill="#a78bfa" />
      <path d="M24 28 Q 22 20 30 24 Z" fill="#7c3aed" />
      <path d="M76 28 Q 78 20 70 24 Z" fill="#7c3aed" />
      <circle cx="40" cy="44" r="6" fill="white" />
      <circle cx="60" cy="44" r="6" fill="white" />
      <circle cx="41" cy="45" r="2.6" fill="#1a1a2e" />
      <circle cx="61" cy="45" r="2.6" fill="#1a1a2e" />
      <circle cx="42" cy="43" r="0.8" fill="white" />
      <circle cx="62" cy="43" r="0.8" fill="white" />
      <circle cx="30" cy="52" r="3.5" fill="#f9a8d4" opacity="0.7" />
      <circle cx="70" cy="52" r="3.5" fill="#f9a8d4" opacity="0.7" />
      <path d="M 42 55 Q 50 62 58 55" stroke="#1a1a2e" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* waving hand */}
      <g>
        <ellipse cx="83" cy="48" rx="8" ry="6" fill="#a78bfa" />
        <ellipse cx="83" cy="48" rx="4" ry="3" fill="#f9a8d4" opacity="0.5" />
      </g>
    </svg>
  );
}

/**
 * Peeking pose: only the top of the head + eyes show, with two little hands
 * gripping an imaginary wall edge at the bottom of the SVG.
 */
function PeekingMascot() {
  return (
    <svg viewBox="0 0 100 70" width="86" height="60" style={{ pointerEvents: "none" }}>
      {/* tiny shadow */}
      <ellipse cx="50" cy="66" rx="18" ry="2" fill="rgba(0,0,0,0.25)" />
      {/* head poking up (only the top half — bottom cut by hands) */}
      <path
        d="M 22 50 Q 22 14 50 14 Q 78 14 78 50 Z"
        fill="#a78bfa"
      />
      {/* ear tufts */}
      <path d="M22 32 Q 18 16 32 22 Z" fill="#a78bfa" />
      <path d="M78 32 Q 82 16 68 22 Z" fill="#a78bfa" />
      {/* eyes (looking around) */}
      <circle cx="40" cy="40" r="6" fill="white" />
      <circle cx="60" cy="40" r="6" fill="white" />
      <circle cx="41" cy="41" r="2.6" fill="#1a1a2e" />
      <circle cx="61" cy="41" r="2.6" fill="#1a1a2e" />
      <circle cx="42" cy="39" r="0.8" fill="white" />
      <circle cx="62" cy="39" r="0.8" fill="white" />
      {/* hands gripping the bottom edge — knuckles up */}
      <g>
        <ellipse cx="22" cy="50" rx="10" ry="5" fill="#a78bfa" />
        <ellipse cx="78" cy="50" rx="10" ry="5" fill="#a78bfa" />
        <circle cx="17" cy="48" r="2" fill="#7c3aed" />
        <circle cx="22" cy="47" r="2" fill="#7c3aed" />
        <circle cx="27" cy="48" r="2" fill="#7c3aed" />
        <circle cx="73" cy="48" r="2" fill="#7c3aed" />
        <circle cx="78" cy="47" r="2" fill="#7c3aed" />
        <circle cx="83" cy="48" r="2" fill="#7c3aed" />
      </g>
    </svg>
  );
}
