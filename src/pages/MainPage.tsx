// pages/MainPage.tsx
// Página principal do JGP Meeting: controle de gravação e transcrição em tempo real.

import React, { useState, useCallback, useEffect } from "react";
import clsx from "clsx";
import { Mic, MicOff, AlertCircle, X, Volume2, VolumeX } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useTranscription } from "@/hooks/useTranscription";
import { useDetection } from "@/hooks/useDetection";
import { AudioIndicator } from "@/components/AudioIndicator";
import { TranscriptionPanel } from "@/components/TranscriptionPanel";
import { MeetingTypeSelector } from "@/components/MeetingTypeSelector";
import { DetectionBanner } from "@/components/DetectionBanner";
import type { MeetingType } from "@/types";

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

  const { isCapturing, audioLevel, micLevel, micMuted, isProcessing, error, duration } = captureState;

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

  const handleStart = useCallback(async () => {
    transcriptionActions.unmuteUpdates(); // Volta a escutar atualizações
    transcriptionActions.clearTranscript();
    await captureActions.start(meetingType);
  }, [captureActions, transcriptionActions, meetingType]);

  const handleStop = useCallback(async () => {
    const meetingId = await captureActions.stop();
    if (meetingId) onMeetingSaved?.(meetingId);
    // Limpa a tela para a próxima reunião.
    // A transcrição já foi salva no backend — o draining continua em background
    // e o resultado final aparece no Histórico (via evento meeting-updated).
    transcriptionActions.muteUpdates(); // Ignora updates do draining
    transcriptionActions.clearTranscript();
  }, [captureActions, transcriptionActions, onMeetingSaved]);

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
                <p className="text-xs font-semibold text-primary-700 dark:text-primary-400">Ouvindo...</p>
                <p className="text-[10px] text-primary-500 dark:text-primary-500/70">
                  {isProcessing ? "Transcrevendo chunk..." : "Aguardando fala"}
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
                  <AudioIndicator
                    isActive={isCapturing}
                    level={audioLevel}
                    size="lg"
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
                    <AudioIndicator
                      isActive={isCapturing && !micMuted}
                      level={micMuted ? 0 : micLevel}
                      size="lg"
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
          transcript={transcript}
          isCapturing={isCapturing}
          isProcessing={isProcessing}
          duration={duration}
          className="h-full"
        />
      </div>
    </div>
  );
};
