// components/Navigation.tsx
// Sidebar de navegação lateral do aplicativo.
// Permite alternar entre as páginas: Principal, Histórico e Configurações.
// Mostra indicadores de gravação ativa e draining (transcrição pós-stop).

import React from "react";
import clsx from "clsx";
import { Mic, Clock, Settings, Zap, Loader2 } from "lucide-react";
import type { AppPage } from "@/types";

interface NavItem {
  id: AppPage;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { id: "main", label: "Reunião", icon: Mic },
  { id: "history", label: "Histórico", icon: Clock },
  { id: "settings", label: "Config", icon: Settings },
];

interface NavigationProps {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  isRecording?: boolean;
  /** Draining: transcrição pós-stop em andamento */
  isDraining?: boolean;
  /** Progresso do draining (0 a 1) */
  drainingProgress?: number;
  /** Chunks pendentes */
  drainingPending?: number;
  /** Total de chunks */
  drainingTotal?: number;
}

export const Navigation: React.FC<NavigationProps> = ({
  currentPage,
  onNavigate,
  isRecording = false,
  isDraining = false,
  drainingProgress = 0,
  drainingPending = 0,
  drainingTotal = 0,
}) => {
  return (
    <aside className="w-16 flex-shrink-0 bg-surface-900 dark:bg-[#080a12] flex flex-col items-center py-4 gap-1 border-r border-surface-800/50 dark:border-surface-800/30">
      {/* Logo */}
      <div className="mb-4 flex items-center justify-center w-10 h-10 rounded-xl bg-primary-500 shadow-lg shadow-primary-500/20">
        <Zap className="w-5 h-5 text-white fill-white" />
      </div>

      {/* Items de navegação */}
      <nav className="flex-1 flex flex-col items-center gap-1 w-full px-2">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const isActive = currentPage === id;
          const showRecordingDot = id === "main" && isRecording;

          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              title={label}
              className={clsx(
                "relative w-full flex flex-col items-center justify-center py-2 px-1 rounded-xl",
                "text-xs font-medium transition-all duration-150 gap-1",
                "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-surface-900",
                isActive
                  ? "bg-primary-500/15 text-primary-400"
                  : "text-surface-500 hover:text-surface-300 hover:bg-surface-800/70"
              )}
            >
              <div className="relative">
                <Icon className="w-5 h-5" />
                {showRecordingDot && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-500" />
                  </span>
                )}
              </div>
              <span className="text-[10px] leading-none">{label}</span>
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-primary-500 rounded-r-full" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Indicador de draining (transcrição pós-stop) */}
      {isDraining && (
        <div
          className="flex flex-col items-center gap-1.5 mx-2 mb-2 p-2 rounded-xl bg-blue-500/10 border border-blue-500/20"
          title={`Transcrevendo ${drainingTotal - drainingPending}/${drainingTotal} chunks...`}
        >
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          <span className="text-[9px] text-blue-400 font-medium leading-tight text-center">
            {drainingTotal - drainingPending}/{drainingTotal}
          </span>
          {/* Barra de progresso */}
          <div className="w-full h-1 bg-blue-900/40 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-400 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.round(drainingProgress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Versão */}
      <div className="text-[9px] text-surface-700 font-mono">v0.2</div>
    </aside>
  );
};
