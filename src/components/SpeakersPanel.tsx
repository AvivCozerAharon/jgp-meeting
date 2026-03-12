// components/SpeakersPanel.tsx — Feature 10
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SpeakerSegment } from '../types';

// Cores para os diferentes falantes
const SPEAKER_COLORS = [
  'border-l-primary-500 bg-primary-50 dark:bg-primary-500/5',
  'border-l-blue-500 bg-blue-50 dark:bg-blue-500/5',
  'border-l-purple-500 bg-purple-50 dark:bg-purple-500/5',
  'border-l-amber-500 bg-amber-50 dark:bg-amber-500/5',
  'border-l-pink-500 bg-pink-50 dark:bg-pink-500/5',
  'border-l-teal-500 bg-teal-50 dark:bg-teal-500/5',
];

const SPEAKER_BADGE_COLORS = [
  'bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300',
];

interface Props {
  meetingId: string;
  apiKey: string;
  model?: string;
  segments?: SpeakerSegment[] | null;
  onDiarized: (segments: SpeakerSegment[]) => void;
}

export function SpeakersPanel({ meetingId, apiKey, model, segments, onDiarized }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diarize = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<SpeakerSegment[]>('diarize_transcript', {
        meetingId,
        apiKey,
        model: model ?? null,
      });
      onDiarized(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Mapa de cor por nome de falante
  const speakerColorMap = new Map<string, number>();
  let colorIdx = 0;
  const getColor = (name: string) => {
    if (!speakerColorMap.has(name)) {
      speakerColorMap.set(name, colorIdx++ % SPEAKER_COLORS.length);
    }
    return speakerColorMap.get(name)!;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 flex items-center gap-2">
          <span>👥</span> Falantes Identificados
        </h3>
        <button
          onClick={diarize}
          disabled={loading || !apiKey}
          className={[
            'text-xs px-3 py-1.5 rounded font-medium transition-all',
            segments && segments.length > 0
              ? 'bg-surface-200 hover:bg-surface-300 text-surface-700 dark:bg-surface-700 dark:hover:bg-surface-600 dark:text-surface-300'
              : 'bg-purple-600 hover:bg-purple-700 text-white',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {loading ? (
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              Analisando...
            </span>
          ) : segments && segments.length > 0 ? (
            'Reanalisar'
          ) : (
            'Identificar Falantes'
          )}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-900/20 dark:border-red-900/40 rounded px-3 py-2">
          {error}
        </p>
      )}

      {segments && segments.length > 0 ? (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {segments.map((seg) => {
            const ci = getColor(seg.speaker);
            return (
              <div
                key={seg.index}
                className={`border-l-2 pl-3 py-1.5 rounded-r-md ${SPEAKER_COLORS[ci]}`}
              >
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${SPEAKER_BADGE_COLORS[ci]}`}
                >
                  {seg.speaker}
                </span>
                <p className="mt-1.5 text-xs text-surface-700 dark:text-surface-300 leading-relaxed">{seg.text}</p>
              </div>
            );
          })}
        </div>
      ) : (
        !loading && (
          <p className="text-xs text-surface-500 dark:text-surface-500 italic">
            Analisa a transcrição para identificar automaticamente os diferentes participantes.
          </p>
        )
      )}
    </div>
  );
}
