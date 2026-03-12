// hooks/useDraining.ts
// Hook global para monitorar o estado de draining (transcrição de chunks
// pendentes após a reunião encerrar). Deve ser usado no nível do App.tsx
// para que o indicador seja visível em qualquer página.

import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TranscriptionDrainingPayload } from "@/types";

export interface DrainingState {
  /** Se há draining ativo */
  isDraining: boolean;
  /** Chunks pendentes */
  pending: number;
  /** Total de chunks a processar */
  total: number;
  /** Progresso de 0 a 1 */
  progress: number;
}

/**
 * Hook que escuta os eventos `transcription-draining` do backend.
 * Retorna o estado atual do draining para exibição global (ex: Navigation).
 *
 * Quando o backend encerra a gravação, ele continua processando chunks
 * pendentes (especialmente com Whisper local, que é lento). Este hook
 * permite mostrar o progresso independente de qual página está ativa.
 */
export function useDraining(): DrainingState {
  const [draining, setDraining] = useState<TranscriptionDrainingPayload | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<TranscriptionDrainingPayload>("transcription-draining", (event) => {
      const { pending, total } = event.payload;
      if (pending === 0 && total === 0) {
        setDraining(null);
      } else {
        setDraining({ pending, total });
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(console.error);

    return () => {
      unlisten?.();
    };
  }, []);

  if (!draining) {
    return { isDraining: false, pending: 0, total: 0, progress: 1 };
  }

  const progress =
    draining.total > 0
      ? (draining.total - draining.pending) / draining.total
      : 0;

  return {
    isDraining: true,
    pending: draining.pending,
    total: draining.total,
    progress,
  };
}
