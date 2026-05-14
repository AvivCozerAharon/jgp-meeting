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

  // Timer local — parado quando pausado
  useEffect(() => {
    if (isPaused) return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [isPaused]);

  // Sincroniza estado inicial + poll de fallback (5s)
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
    const poll = setInterval(sync, 5000);
    return () => clearInterval(poll);
  }, []);

  // Eventos em tempo real
  useEffect(() => {
    const unsubs = [
      listen<boolean>("capture-paused", (e) => setIsPaused(e.payload)),
      listen<string>("recording-stopped", () => {
        invoke("close_compliance_window").catch(() => {});
      }),
    ];
    return () => { unsubs.forEach((p) => p.then((fn) => fn())); };
  }, []);

  // Optimistic updates — UI responde imediatamente
  const handleMute = useCallback(() => {
    setMicMuted((v) => !v);
    invoke<boolean>("toggle_mic_mute")
      .then(setMicMuted)
      .catch(() => setMicMuted((v) => !v));
  }, []);

  const handlePause = useCallback(() => {
    setIsPaused((v) => !v);
    invoke<boolean>("toggle_pause_capture")
      .then(setIsPaused)
      .catch(() => setIsPaused((v) => !v));
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await invoke("stop_capture");
    } catch {
      invoke("close_compliance_window").catch(() => {});
    }
  }, []);

  const accentColor = isPaused ? "#f59e0b" : "#ef4444";
  const accentDim   = isPaused ? "rgba(245,158,11,0.18)" : "rgba(239,68,68,0.18)";

  return (
    <div
      style={{
        margin: 10,
        padding: "0 12px",
        height: 44,
        borderRadius: 22,
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "rgba(22, 22, 24, 0.82)",
        backdropFilter: "blur(20px) saturate(160%)",
        WebkitBackdropFilter: "blur(20px) saturate(160%)",
        border: "1px solid rgba(255,255,255,0.09)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.35)",
        WebkitAppRegion: "drag",
        userSelect: "none",
        cursor: "default",
      } as React.CSSProperties}
    >
      {/* Logo JGP */}
      <img
        src={jgpLogo}
        alt="JGP"
        style={{
          height: 18,
          width: "auto",
          opacity: 0.85,
          flexShrink: 0,
          pointerEvents: "none",
        }}
      />

      {/* Separador */}
      <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.10)", flexShrink: 0 }} />

      {/* Badge REC / PAUSADO */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 7px 2px 5px",
          borderRadius: 7,
          background: accentDim,
          border: `1px solid ${accentColor}30`,
          flexShrink: 0,
        }}
      >
        {isPaused ? (
          <Pause size={9} color={accentColor} strokeWidth={2.5} />
        ) : (
          <span className="rec-dot" style={{
            display: "block",
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: accentColor,
            flexShrink: 0,
          }} />
        )}
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: accentColor,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {isPaused ? "PAUSADO" : "REC"}
        </span>
      </div>

      {/* Timer */}
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
          color: "rgba(255,255,255,0.80)",
          letterSpacing: "0.03em",
          flexShrink: 0,
          minWidth: 38,
        }}
      >
        {formatDuration(duration)}
      </span>

      {/* Separador */}
      <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.10)", flexShrink: 0 }} />

      {/* Controles */}
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <button
          className={`ctrl-btn${micMuted ? " active" : ""}`}
          onClick={handleMute}
          title={micMuted ? "Desmutar microfone" : "Mutar microfone"}
        >
          {micMuted ? <MicOff size={12} strokeWidth={2} /> : <Mic size={12} strokeWidth={2} />}
        </button>

        <button
          className="ctrl-btn"
          onClick={handlePause}
          title={isPaused ? "Retomar gravação" : "Pausar gravação"}
        >
          {isPaused
            ? <Play size={12} strokeWidth={2} />
            : <Pause size={12} strokeWidth={2} />}
        </button>

        <button
          className="ctrl-btn danger"
          onClick={handleStop}
          title="Parar gravação"
        >
          <Square size={10} strokeWidth={0} fill="currentColor" />
        </button>
      </div>
    </div>
  );
};
