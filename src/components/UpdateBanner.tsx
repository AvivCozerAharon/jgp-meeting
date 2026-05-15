import { useState } from "react";
import clsx from "clsx";
import { Bell, X, ChevronDown, ChevronUp, Download } from "lucide-react";

interface UpdateBannerProps {
  version: string;
  notes: string;
  onInstall: () => void;
  onDismiss: () => void;
  installing: boolean;
  progress: number | null;
}

export function UpdateBanner({
  version,
  notes,
  onInstall,
  onDismiss,
  installing,
  progress,
}: UpdateBannerProps) {
  const [notesOpen, setNotesOpen] = useState(false);

  const noteLines = notes
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div className={clsx(
      "w-full border-b px-4 py-3",
      "bg-primary-50 border-primary-200 dark:bg-primary-500/10 dark:border-primary-500/30"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Bell className="w-4 h-4 text-primary-500 dark:text-primary-400 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary-800 dark:text-primary-200">
              Nova versão disponível: v{version}
            </p>
            <p className="text-xs text-primary-600 dark:text-primary-400 mt-0.5">
              É sempre importante manter o app atualizado para receber melhorias e correções.
            </p>

            {noteLines.length > 0 && (
              <button
                onClick={() => setNotesOpen((v) => !v)}
                className="flex items-center gap-1 mt-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:text-primary-800 dark:hover:text-primary-200 transition-colors"
              >
                {notesOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {notesOpen ? "Ocultar o que mudou" : "Ver o que mudou"}
              </button>
            )}

            {notesOpen && (
              <ul className="mt-2 space-y-0.5 pl-1">
                {noteLines.map((line, i) => (
                  <li key={i} className="text-xs text-primary-700 dark:text-primary-300 flex items-start gap-1.5">
                    <span className="text-primary-400 mt-0.5 flex-shrink-0">•</span>
                    <span>{line.replace(/^[-•]\s*/, "")}</span>
                  </li>
                ))}
              </ul>
            )}

            {installing && progress !== null && (
              <div className="mt-2 w-48">
                <div className="h-1 bg-primary-200 dark:bg-primary-500/30 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary-500 dark:bg-primary-400 rounded-full transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-[10px] text-primary-500 dark:text-primary-400 mt-0.5">{progress}% baixado</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onInstall}
            disabled={installing}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
              "bg-primary-500 text-white hover:bg-primary-600 shadow-sm",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            <Download className="w-3.5 h-3.5" />
            {installing ? "Instalando..." : "Instalar e Reiniciar"}
          </button>

          {!installing && (
            <button
              onClick={onDismiss}
              className="p-1 rounded-md text-primary-400 hover:text-primary-600 dark:hover:text-primary-200 hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors"
              title="Fechar"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
