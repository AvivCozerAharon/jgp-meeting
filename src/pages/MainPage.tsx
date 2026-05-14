// pages/MainPage.tsx
// Página principal do JGP Meeting: controle de gravação e transcrição em tempo real.

import React, { useState, useCallback, useEffect } from "react";
import clsx from "clsx";
import { Mic, MicOff, AlertCircle, X, Volume2, VolumeX, Pause, Play } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useTranscription } from "@/hooks/useTranscription";
import { useDetection } from "@/hooks/useDetection";
import { AudioIndicator } from "@/components/AudioIndicator";
import { WaveformBars } from "@/components/WaveformBars";
import { TranscriptionPanel } from "@/components/TranscriptionPanel";
import { MeetingTypeSelector } from "@/components/MeetingTypeSelector";
import { DetectionBanner } from "@/components/DetectionBanner";
import type { MeetingType } from "@/types";

function formatDuration(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

interface MainPageProps {
  onMeetingSaved?: (meetingId: string) => void;
  /** Callback para informar App.tsx se está gravando (para Navigation indicator) */
  onRecordingChange?: (isRecording: boolean) => void;
}

export const MainPage: React.FC<MainPageProps> = ({ onMeetingSaved, onRecordingChange }) => {
  const [captureState, captureActions] = useAudioCapture();
  const [transcriptionState, transcriptionActions] = useTranscription();

  const [meetingType, setMeetingType] = useState<MeetingType>('general');
  const [micActive, setMicActive] = useState(false);

  const { isCapturing, audioLevel, micLevel, micMuted, isProcessing, error, duration, isPaused } = captureState;

  // Reporta estado de gravação ao App.tsx (para o indicador na Navigation)
  useEffect(() => {
    onRecordingChange?.(isCapturing);
  }, [isCapturing, onRecordingChange]);

  // Detecta se o microfone está ativo na sessão atual.
  // Uma vez que recebe sinal do mic (micLevel > threshold), marca como ativo
  // e só reseta quando a captura para.
  useEffect(() => {
    if (!isCapturing) {
      setMicActive(false);
    } else if (micLevel > 0.001) {
      setMicActive(true);
    }
  }, [isCapturing, micLevel]);
  const { transcript } = transcriptionState;

  const { detectedApps, showBanner, dismiss } = useDetection(isCapturing);

  // Escuta atalho global (toggle-recording)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<void>('toggle-recording', () => {
      if (isCapturing) {
        handleStop();
      } else {
        handleStart();
      }
    }).then(fn => { unlisten = fn; }).catch(console.error);
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCapturing]);

  // Escuta atalho global (toggle-mic-mute)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<void>('toggle-mic-mute', () => {
      if (isCapturing) {
        captureActions.toggleMicMute();
      }
    }).then(fn => { unlisten = fn; }).catch(console.error);
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCapturing, captureActions]);

  // Escuta atalho global (toggle-pause)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<void>('toggle-pause', () => {
      if (isCapturing) captureActions.togglePause();
    }).then(fn => { unlisten = fn; }).catch(console.error);
    return () => { unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCapturing, captureActions]);

  const handleStart = useCallback(async () => {
    transcriptionActions.unmuteUpdates();
    transcriptionActions.clearTranscript();
    await captureActions.start(meetingType);
    invoke("open_compliance_window").catch(console.error);
  }, [captureActions, transcriptionActions, meetingType]);

  const handleStop = useCallback(async () => {
    invoke("close_compliance_window").catch(console.error);
    // Apenas chama stop — o cleanup (muteUpdates, clearTranscript, onMeetingSaved)
    // é feito pelo listener de "recording-stopped" abaixo, o que cobre tanto
    // o stop pelo botão principal quanto pelo compliance overlay.
    await captureActions.stop();
  }, [captureActions]);

  // Cleanup único para qualquer origem de stop (botão, compliance, atalho)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<string>("recording-stopped", (e) => {
      // Payload vazio = parou sem salvar (transcrição vazia) — não notifica como reunião salva
      if (e.payload) onMeetingSaved?.(e.payload);
      transcriptionActions.muteUpdates();
      transcriptionActions.clearTranscript();
      invoke("close_compliance_window").catch(() => {});
    }).then(fn => { unlisten = fn; }).catch(console.error);
    return () => { unlisten?.(); };
  }, [onMeetingSaved, transcriptionActions]);

  return (
    <div className="flex flex-col h-full bg-surface-50 dark:bg-[#0c0f17]">
      {/* Header */}
      <div className="bg-white dark:bg-surface-900/50 border-b border-surface-100 dark:border-surface-800/50 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-surface-900 dark:text-surface-100">JGP Meeting</h1>
            <p className="text-xs text-surface-500 dark:text-surface-500 mt-0.5">
              Transcrição inteligente de reuniões em tempo real
            </p>
          </div>

          {/* Indicador de status (só durante gravação) */}
          {isCapturing && (
            <div className="flex items-center gap-3 px-4 py-2 bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/20 rounded-xl">
              <AudioIndicator isActive level={audioLevel} size="md" />
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-xs font-semibold text-primary-700 dark:text-primary-400">Ouvindo...</p>
                  <span className={clsx(
                    "text-xs font-mono font-semibold tabular-nums",
                    isPaused ? "text-amber-500 dark:text-amber-400" : "text-primary-600 dark:text-primary-400"
                  )}>
                    {formatDuration(duration)}
                  </span>
                </div>
                <p className="text-[10px] text-primary-500 dark:text-primary-500/70">
                  {isPaused ? "Pausado" : isProcessing ? "Transcrevendo chunk..." : "Aguardando fala"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Banner de detecção */}
      {showBanner && (
        <div className="mx-6 mt-4 flex-shrink-0">
          <DetectionBanner
            apps={detectedApps}
            onStartRecording={handleStart}
            onDismiss={dismiss}
          />
        </div>
      )}

      {/* Barra de erro */}
      {error && (
        <div className="mx-6 mt-4 flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-sm text-red-700 dark:text-red-400 animate-fade-in flex-shrink-0">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={captureActions.clearError}
            className="text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Controle Principal */}
      <div className="px-6 pt-4 pb-2 flex-shrink-0">
        <div className="bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50 rounded-2xl p-5 shadow-card dark:shadow-none">
          <div className="flex items-center gap-5">
            {/* Botão Start/Stop */}
            <button
              onClick={isCapturing ? handleStop : handleStart}
              className={clsx(
                "flex items-center gap-2.5 px-6 py-3 rounded-xl font-semibold text-sm",
                "transition-all duration-200 shadow-sm focus:outline-none",
                "focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-surface-800",
                isCapturing
                  ? "bg-red-500 text-white hover:bg-red-600 focus:ring-red-500"
                  : "bg-primary-500 text-white hover:bg-primary-600 focus:ring-primary-500"
              )}
            >
              {isCapturing ? (
                <>
                  <MicOff className="w-4 h-4" />
                  Stop Listening
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" />
                  Start Listening
                </>
              )}
            </button>

            {/* Indicadores de áudio: sistema + microfone */}
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-1.5">
                  <Volume2 className={clsx(
                    "w-3.5 h-3.5",
                    isCapturing ? "text-primary-500" : "text-surface-400 dark:text-surface-600"
                  )} />
                  <WaveformBars
                    level={audioLevel}
                    isActive={isCapturing}
                    color="bg-blue-500"
                  />
                </div>
                <span className="text-[10px] text-surface-400 dark:text-surface-500 font-mono">
                  {isCapturing ? "Sistema" : "Inativo"}
                </span>
              </div>

              {/* Indicador de microfone (aparece quando mic está captando) */}
              {isCapturing && micActive && (
                <div className="flex flex-col items-center gap-1 animate-fade-in">
                  <div className="flex items-center gap-1.5">
                    <Mic className={clsx(
                      "w-3.5 h-3.5",
                      micMuted ? "text-surface-400 dark:text-surface-600" : "text-blue-500"
                    )} />
                    <WaveformBars
                      level={micMuted ? 0 : micLevel}
                      isActive={isCapturing && !micMuted}
                      color="bg-emerald-500"
                    />
                  </div>
                  <span className={clsx(
                    "text-[10px] font-mono",
                    micMuted
                      ? "text-surface-400 dark:text-surface-600 line-through"
                      : "text-blue-400 dark:text-blue-500"
                  )}>
                    Microfone
                  </span>
                </div>
              )}

              {/* Botão Mutar/Desmutar microfone */}
              {isCapturing && (
                <button
                  onClick={captureActions.toggleMicMute}
                  title={micMuted ? "Desmutar microfone" : "Mutar microfone"}
                  className={clsx(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
                    "transition-all duration-150 border",
                    micMuted
                      ? "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20"
                      : "bg-surface-50 dark:bg-surface-700/50 border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-700"
                  )}
                >
                  {micMuted ? (
                    <>
                      <VolumeX className="w-3.5 h-3.5" />
                      Mic Off
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5" />
                      Mic On
                    </>
                  )}
                </button>
              )}

              {/* Botão Pausar/Retomar transcrição */}
              {isCapturing && (
                <button
                  onClick={captureActions.togglePause}
                  title={isPaused ? "Retomar transcrição (Ctrl+Shift+P)" : "Pausar transcrição (Ctrl+Shift+P)"}
                  className={clsx(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
                    "transition-all duration-150 border",
                    isPaused
                      ? "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20"
                      : "bg-surface-50 dark:bg-surface-700/50 border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-700"
                  )}
                >
                  {isPaused ? (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      Retomar
                    </>
                  ) : (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      Pausar
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Seletor de tipo */}
          <div className="mt-4 pt-4 border-t border-surface-100 dark:border-surface-700/50">
            <MeetingTypeSelector
              value={meetingType}
              onChange={setMeetingType}
              disabled={isCapturing}
            />
          </div>

          {/* Dica */}
          {!isCapturing && !transcript && (
            <p className="mt-3 text-xs text-surface-400 dark:text-surface-500 leading-relaxed">
              Inicie uma chamada no Zoom, Google Meet ou Teams, depois clique em
              Start Listening para transcrever automaticamente.
            </p>
          )}
        </div>
      </div>

      {/* Área de conteúdo: Transcrição */}
      <div className="flex-1 px-6 pb-6 min-h-0 mt-2">
        <TranscriptionPanel
          segments={transcriptionState.segments}
          meetingId={null}
          isCapturing={isCapturing}
          isProcessing={isProcessing}
          duration={duration}
          className="h-full"
        />
      </div>
    </div>
  );
};
