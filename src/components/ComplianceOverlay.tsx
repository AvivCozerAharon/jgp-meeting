// ComplianceOverlay.tsx
// Janela flutuante always-on-top exibida durante a gravação.

import { useEffect, useLayoutEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Mic, MicOff, Pause, Play, Square } from "lucide-react";
import jgpLogo from "../assets/marca-jgp-white.png";

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ── Sub-componente de botão ───────────────────────────────────────────────────

interface CtrlBtnProps {
  onClick: () => void;
  title: string;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}

const CtrlBtn: React.FC<CtrlBtnProps> = ({ onClick, title, active, danger, children }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      width: 28,
      height: 28,
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      border: `1px solid ${active ? "rgba(239,68,68,0.5)" : "rgba(255,255,255,0.08)"}`,
      background: active
        ? "rgba(239,68,68,0.22)"
        : danger
        ? "rgba(239,68,68,0.12)"
        : "rgba(255,255,255,0.06)",
      color: active
        ? "#fca5a5"
        : danger
        ? "rgba(239,68,68,0.85)"
        : "rgba(255,255,255,0.65)",
      cursor: "pointer",
      transition: "background 0.15s, color 0.15s, border-color 0.15s",
      flexShrink: 0,
      WebkitAppRegion: "no-drag",
    } as React.CSSProperties}
    onMouseEnter={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.background = danger
        ? "rgba(239,68,68,0.28)"
        : active
        ? "rgba(239,68,68,0.35)"
        : "rgba(255,255,255,0.12)";
      el.style.color = danger ? "#fca5a5" : "rgba(255,255,255,0.9)";
    }}
    onMouseLeave={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.background = active
        ? "rgba(239,68,68,0.22)"
        : danger
        ? "rgba(239,68,68,0.12)"
        : "rgba(255,255,255,0.06)";
      el.style.color = active
        ? "#fca5a5"
        : danger
        ? "rgba(239,68,68,0.85)"
        : "rgba(255,255,255,0.65)";
    }}
  >
    {children}
  </button>
);

// ── Separador vertical ────────────────────────────────────────────────────────

const Sep: React.FC = () => (
  <div
    style={{
      width: 1,
      height: 20,
      background: "rgba(255,255,255,0.10)",
      flexShrink: 0,
    }}
  />
);

// ── Componente principal ──────────────────────────────────────────────────────

export const ComplianceOverlay = () => {
  const [micMuted, setMicMuted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [duration, setDuration] = useState(0);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("background", "transparent", "important");
    document.body.style.setProperty("background", "transparent", "important");
    document.documentElement.className = "";
    document.body.className = "";
  }, []);

  // Timer local — para quando pausado
  useEffect(() => {
    if (isPaused) return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [isPaused]);

  // Sincroniza estado inicial + poll completo de status
  useEffect(() => {
    const sync = async () => {
      try {
        const s = await invoke<{
          mic_muted: boolean;
          is_paused: boolean;
          duration_secs: number;
          is_capturing: boolean;
        }>("get_capture_status");
        setMicMuted(s.mic_muted);
        setIsPaused(s.is_paused);
        setDuration((d) => (Math.abs(s.duration_secs - d) > 2 ? s.duration_secs : d));
        if (!s.is_capturing) {
          invoke("close_compliance_window").catch(() => {});
        }
      } catch {}
    };

    sync();
    const poll = setInterval(sync, 2000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    const unsubs = [
      listen<boolean>("capture-paused", (e) => setIsPaused(e.payload)),
      listen<string>("recording-stopped", () => {
        invoke("close_compliance_window").catch(() => {});
      }),
    ];
    return () => { unsubs.forEach((p) => p.then((fn) => fn())); };
  }, []);

  const handleMute = useCallback(async () => {
    try { setMicMuted(await invoke<boolean>("toggle_mic_mute")); } catch {}
  }, []);

  const handlePause = useCallback(async () => {
    try { setIsPaused(await invoke<boolean>("toggle_pause_capture")); } catch {}
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await invoke("stop_capture");
    } catch (e) {
      console.error("stop_capture falhou:", e);
      invoke("close_compliance_window").catch(() => {});
    }
  }, []);

  const accentColor = isPaused ? "#f59e0b" : "#ef4444";
  const accentDim   = isPaused ? "rgba(245,158,11,0.18)" : "rgba(239,68,68,0.18)";

  return (
    <div
      style={{
        margin: 10,
        padding: "0 14px",
        height: 52,
        borderRadius: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "rgba(11, 13, 20, 0.90)",
        backdropFilter: "blur(24px) saturate(180%)",
        WebkitBackdropFilter: "blur(24px) saturate(180%)",
        border: "1px solid rgba(255,255,255,0.07)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset",
        WebkitAppRegion: "drag",
        userSelect: "none",
        cursor: "default",
      } as React.CSSProperties}
    >
      {/* ── Logo JGP ── */}
      <img
        src={jgpLogo}
        alt="JGP"
        style={{
          height: 22,
          width: "auto",
          opacity: 0.85,
          flexShrink: 0,
          pointerEvents: "none",
        }}
      />

      <Sep />

      {/* ── Badge REC / PAUSADO ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px 3px 6px",
          borderRadius: 8,
          background: accentDim,
          border: `1px solid ${accentColor}30`,
          flexShrink: 0,
        }}
      >
        {isPaused ? (
          <Pause size={10} color={accentColor} strokeWidth={2.5} />
        ) : (
          <span style={{ position: "relative", width: 8, height: 8, flexShrink: 0 }}>
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: accentColor,
                opacity: 0.5,
                animation: "ping 1.2s cubic-bezier(0,0,0.2,1) infinite",
              }}
            />
            <span
              style={{
                position: "relative",
                display: "block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: accentColor,
              }}
            />
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.10em",
            color: accentColor,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {isPaused ? "PAUSADO" : "REC"}
        </span>
      </div>

      {/* ── Timer ── */}
      <span
        style={{
          fontSize: 15,
          fontWeight: 600,
          fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
          color: "rgba(255,255,255,0.90)",
          letterSpacing: "0.03em",
          flexShrink: 0,
          minWidth: 44,
        }}
      >
        {formatDuration(duration)}
      </span>

      <Sep />

      {/* ── Controles ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <CtrlBtn
          onClick={handleMute}
          title={micMuted ? "Desmutar microfone" : "Mutar microfone"}
          active={micMuted}
        >
          {micMuted ? <MicOff size={13} strokeWidth={2} /> : <Mic size={13} strokeWidth={2} />}
        </CtrlBtn>

        <CtrlBtn
          onClick={handlePause}
          title={isPaused ? "Retomar gravação" : "Pausar gravação"}
        >
          {isPaused
            ? <Play size={13} strokeWidth={2} />
            : <Pause size={13} strokeWidth={2} />}
        </CtrlBtn>

        <CtrlBtn onClick={handleStop} title="Parar gravação" danger>
          <Square size={11} strokeWidth={0} fill="currentColor" />
        </CtrlBtn>
      </div>
    </div>
  );
};
