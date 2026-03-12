// hooks/useDetection.ts — Feature 12
// Detecta apps de reunião em execução e notifica o usuário.
import { useState, useEffect, useCallback } from 'react';
import { checkMeetingApps } from '../services/detectionService';
import type { DetectedApp } from '../types';

const POLL_INTERVAL_MS = 30_000; // verifica a cada 30 segundos

export function useDetection(isCapturing: boolean) {
  const [detectedApps, setDetectedApps] = useState<DetectedApp[]>([]);
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    // Não verifica quando já está gravando
    if (isCapturing) {
      setDetectedApps([]);
      return;
    }
    try {
      const apps = await checkMeetingApps();
      setDetectedApps(apps);
      // Reseta o dismiss quando novos apps são detectados
      if (apps.length > 0) setDismissed(false);
    } catch {
      // silencia erros de detecção
    }
  }, [isCapturing]);

  // Verifica imediatamente e a cada POLL_INTERVAL_MS
  useEffect(() => {
    check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [check]);

  const dismiss = useCallback(() => setDismissed(true), []);

  const showBanner = detectedApps.length > 0 && !dismissed && !isCapturing;

  return { detectedApps, showBanner, dismiss };
}
