// components/DetectionBanner.tsx — Feature 12
import type { DetectedApp } from '../types';

interface Props {
  apps: DetectedApp[];
  onStartRecording: () => void;
  onDismiss: () => void;
}

export function DetectionBanner({ apps, onStartRecording, onDismiss }: Props) {
  if (apps.length === 0) return null;

  const appNames = apps.map((a) => a.name).join(', ');

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-primary-500/10 border border-primary-500/20 rounded-xl text-sm dark:bg-primary-500/5">
      <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary-500" />
      </span>

      <p className="flex-1 text-surface-600 dark:text-surface-300">
        <span className="font-medium text-primary-600 dark:text-primary-400">{appNames}</span>
        {' '}detectado em execução — deseja gravar esta reunião?
      </p>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onStartRecording}
          className="px-3 py-1 bg-primary-500 hover:bg-primary-600 text-white text-xs font-semibold rounded-lg transition-colors"
        >
          Gravar
        </button>
        <button
          onClick={onDismiss}
          className="px-2 py-1 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 text-xs rounded transition-colors"
        >
          Fechar
        </button>
      </div>
    </div>
  );
}
