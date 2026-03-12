// components/ExportMenu.tsx — Feature 4
import { useState, useRef, useEffect } from 'react';
import { exportMeeting, openExportFolder, ExportFormat } from '../services/exportService';

interface Props {
  meetingId: string;
}

export function ExportMenu({ meetingId }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<ExportFormat | null>(null);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const doExport = async (format: ExportFormat) => {
    setLoading(format);
    setError(null);
    setOpen(false);
    try {
      const path = await exportMeeting(meetingId, format);
      setLastPath(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!!loading}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-200 hover:bg-surface-300 text-surface-800 dark:bg-surface-700 dark:hover:bg-surface-600 dark:text-surface-200 text-sm rounded-lg transition-colors disabled:opacity-50"
        title="Exportar reunião"
      >
        {loading ? (
          <span className="w-4 h-4 border-2 border-surface-400 dark:border-surface-400 border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        )}
        Exportar
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-44 bg-white border border-surface-100 dark:bg-surface-800 dark:border-surface-700 rounded-lg shadow-xl z-50 overflow-hidden">
          <button
            onClick={() => doExport('txt')}
            className="w-full px-4 py-2.5 text-left text-sm text-surface-800 hover:bg-surface-50 dark:text-surface-200 dark:hover:bg-surface-700 flex items-center gap-2"
          >
            <span>📄</span> Texto simples (.txt)
          </button>
          <button
            onClick={() => doExport('md')}
            className="w-full px-4 py-2.5 text-left text-sm text-surface-800 hover:bg-surface-50 dark:text-surface-200 dark:hover:bg-surface-700 flex items-center gap-2"
          >
            <span>📝</span> Markdown (.md)
          </button>
          <div className="border-t border-surface-100 dark:border-surface-700" />
          <button
            onClick={openExportFolder}
            className="w-full px-4 py-2.5 text-left text-sm text-surface-500 hover:bg-surface-50 dark:text-surface-400 dark:hover:bg-surface-700 flex items-center gap-2"
          >
            <span>📁</span> Abrir pasta
          </button>
        </div>
      )}

      {lastPath && (
        <p className="mt-1 text-xs text-primary-700 dark:text-primary-400 truncate max-w-[200px]" title={lastPath}>
          ✓ Salvo
        </p>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400 truncate max-w-[200px]" title={error}>
          Erro ao exportar
        </p>
      )}
    </div>
  );
}
