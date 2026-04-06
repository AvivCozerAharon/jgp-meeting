// ComplianceOverlay.tsx
// Janela flutuante always-on-top exibida durante a gravação.
// Mostra badge "GRAVANDO", timer e controles: mutar mic, pausar, parar.
// Renderizada em uma WebviewWindow Tauri separada (label: "compliance").

import { useEffect, useLayoutEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export const ComplianceOverlay = () => {
  const [micMuted, setMicMuted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [duration, setDuration] = useState(0);

  // Fundo transparente — deve rodar antes do primeiro paint
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("background", "transparent", "important");
    document.body.style.setProperty("background", "transparent", "important");
    document.documentElement.className = "";
    document.body.className = "";
  }, []);

  // Timer local (incrementa a cada segundo)
  useEffect(() => {
    if (isPaused) return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [isPaused]);

  // Na montagem: sincroniza estado inicial do backend (duration, mute, paused)
  useEffect(() => {
    invoke<{ mic_muted: boolean; is_paused: boolean; duration_secs: number }>(
      "get_capture_status"
    )
      .then((s) => {
        setMicMuted(s.mic_muted);
        setIsPaused(s.is_paused);
        setDuration(s.duration_secs);
      })
      .catch(() => {});

    // Poll apenas para mute — duration é gerenciada localmente pelo timer
    const poll = setInterval(async () => {
      try {
        const status = await invoke<{ mic_muted: boolean; is_paused: boolean }>(
          "get_capture_status"
        );
        setMicMuted(status.mic_muted);
      } catch {}
    }, 2000);
    return () => clearInterval(poll);
  }, []);

  // Escuta eventos do backend para resposta imediata
  useEffect(() => {
    const unsubs: Promise<() => void>[] = [
      listen<boolean>("capture-paused", (e) => setIsPaused(e.payload)),
    ];
    return () => { unsubs.forEach((p) => p.then((fn) => fn())); };
  }, []);

  const handleMute = useCallback(async () => {
    try {
      const muted = await invoke<boolean>("toggle_mic_mute");
      setMicMuted(muted);
    } catch (e) { console.error(e); }
  }, []);

  const handlePause = useCallback(async () => {
    try {
      const paused = await invoke<boolean>("toggle_pause_capture");
      setIsPaused(paused);
    } catch (e) { console.error(e); }
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await invoke("stop_capture");
    } catch (e) { console.error(e); }
    // Fecha esta janela independente de erro (stop pode falhar se já parou)
    invoke("close_compliance_window").catch(() => {});
  }, []);

  const bgColor = isPaused
    ? "rgba(180, 83, 9, 0.93)"   // amber quando pausado
    : "rgba(220, 38, 38, 0.93)"; // vermelho quando gravando

  return (
    <div
      className="flex items-center gap-2.5 m-2 px-3 py-2 rounded-xl shadow-2xl select-none"
      style={{
        background: bgColor,
        backdropFilter: "blur(10px)",
        border: "1px solid rgba(255,255,255,0.15)",
        WebkitAppRegion: "drag",
        transition: "background 0.3s",
        userSelect: "none",
      } as React.CSSProperties}
    >
      {/* Indicador pulsante */}
      {!isPaused && (
        <div className="relative flex items-center justify-center w-2.5 h-2.5 flex-shrink-0">
          <span
            className="absolute inline-flex w-full h-full rounded-full opacity-75 animate-ping"
            style={{ background: "rgba(255,255,255,0.8)" }}
          />
          <span
            className="relative inline-flex rounded-full w-2 h-2"
            style={{ background: "white" }}
          />
        </div>
      )}
      {isPaused && (
        <span className="text-white text-xs">⏸</span>
      )}

      {/* Status + timer */}
      <div className="leading-tight flex-1 min-w-0">
        <p className="text-[11px] font-bold tracking-widest text-white leading-none">
          {isPaused ? "PAUSADO" : "GRAVANDO"}
        </p>
        <p className="text-[10px] text-white/70 leading-none mt-0.5 font-mono">
          {formatDuration(duration)}
        </p>
      </div>

      {/* Controles — não arrastáveis */}
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {/* Mutar mic */}
        <button
          onClick={handleMute}
          title={micMuted ? "Desmutar microfone" : "Mutar microfone"}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
          style={{
            background: micMuted ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          <span className="text-[13px]">{micMuted ? "🔇" : "🎙️"}</span>
        </button>

        {/* Pausar / retomar */}
        <button
          onClick={handlePause}
          title={isPaused ? "Retomar gravação" : "Pausar gravação"}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
          style={{
            background: "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          <span className="text-[13px]">{isPaused ? "▶️" : "⏸"}</span>
        </button>

        {/* Parar */}
        <button
          onClick={handleStop}
          title="Parar gravação"
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
          style={{
            background: "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          <span className="text-[13px]">⏹</span>
        </button>
      </div>
    </div>
  );
};
