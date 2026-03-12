// pages/SettingsPage.tsx
// Página de configurações do aplicativo.

import React from "react";
import { Settings } from "lucide-react";
import { SettingsPanel } from "@/components/SettingsModal";

export const SettingsPage: React.FC = () => {
  return (
    <div className="flex flex-col h-full bg-surface-50 dark:bg-[#0c0f17]">
      {/* Header */}
      <div className="bg-white dark:bg-surface-900/50 border-b border-surface-100 dark:border-surface-800/50 px-6 py-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-surface-400 dark:text-surface-500" />
          <h1 className="text-lg font-bold text-surface-900 dark:text-surface-100">Configurações</h1>
        </div>
        <p className="text-xs text-surface-500 mt-0.5">
          Configure as integrações de API e preferências do aplicativo
        </p>
      </div>

      {/* Conteúdo */}
      <div className="flex-1 overflow-y-auto p-6">
        <SettingsPanel />
      </div>
    </div>
  );
};
