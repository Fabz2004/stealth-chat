import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

type NotifPayload = { author: string; preview: string };

export default function Mascot() {
  const [bubble, setBubble] = useState<{ author: string; expires: number } | null>(null);
  const [waving, setWaving] = useState(false);
  const [opacity, setOpacity] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem("mascot.opacity") ?? "1");
    return Number.isFinite(v) ? v : 1;
  });

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    listen<NotifPayload>("mascot:notify", (e) => {
      setBubble({ author: e.payload.author, expires: Date.now() + 5000 });
      setWaving(true);
      setTimeout(() => setWaving(false), 1600);
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

  return (
    <div className="mascot-root" style={{ opacity }}>
      {bubble && (
        <div className="speech-bubble">
          <span>👋 {bubble.author}</span>
        </div>
      )}
      <div className={`mascot-body ${waving ? "wave" : "idle"}`} data-tauri-drag-region>
        <svg viewBox="0 0 100 110" width="86" height="95" style={{ pointerEvents: "none" }}>
          {/* shadow */}
          <ellipse cx="50" cy="102" rx="22" ry="3" fill="rgba(0,0,0,0.35)" />
          {/* tiny body */}
          <ellipse cx="50" cy="78" rx="22" ry="14" fill="#6b46c1" />
          {/* head */}
          <circle cx="50" cy="45" r="30" fill="#a78bfa" />
          {/* ear tufts */}
          <path d="M22 32 Q 18 16 32 22 Z" fill="#a78bfa" />
          <path d="M78 32 Q 82 16 68 22 Z" fill="#a78bfa" />
          <path d="M24 28 Q 22 20 30 24 Z" fill="#7c3aed" />
          <path d="M76 28 Q 78 20 70 24 Z" fill="#7c3aed" />
          {/* eyes whites */}
          <circle cx="40" cy="44" r="6" fill="white" />
          <circle cx="60" cy="44" r="6" fill="white" />
          {/* pupils — slight follow */}
          <circle cx="41" cy="45" r="2.6" fill="#1a1a2e" />
          <circle cx="61" cy="45" r="2.6" fill="#1a1a2e" />
          {/* eye gleam */}
          <circle cx="42" cy="43" r="0.8" fill="white" />
          <circle cx="62" cy="43" r="0.8" fill="white" />
          {/* cheeks */}
          <circle cx="30" cy="52" r="3.5" fill="#f9a8d4" opacity="0.7" />
          <circle cx="70" cy="52" r="3.5" fill="#f9a8d4" opacity="0.7" />
          {/* smile */}
          <path
            d="M 42 55 Q 50 62 58 55"
            stroke="#1a1a2e"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
          />
          {/* waving hand (only on wave) */}
          {waving && (
            <g className="hand">
              <ellipse cx="83" cy="48" rx="8" ry="6" fill="#a78bfa" />
              <ellipse cx="83" cy="48" rx="4" ry="3" fill="#f9a8d4" opacity="0.5" />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
