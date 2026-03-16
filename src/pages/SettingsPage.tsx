// pages/SettingsPage.tsx
// Página de configurações do aplicativo com abas.

import React, { useState } from "react";
import { Settings, Keyboard, Link } from "lucide-react";
import clsx from "clsx";
import { SettingsPanel } from "@/components/SettingsModal";

export type SettingsTab = "config" | "shortcuts" | "jgrc";

const TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "config", label: "Configurações Básicas", icon: Settings },
  { id: "shortcuts", label: "Atalhos", icon: Keyboard },
  { id: "jgrc", label: "Integração JGRC", icon: Link },
];

export const SettingsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>("config");

  return (
    <div className="flex flex-col h-full bg-surface-50 dark:bg-[#0c0f17]">
      {/* Header */}
      <div className="bg-white dark:bg-surface-900/50 border-b border-surface-100 dark:border-surface-800/50 px-6 py-4 flex-shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <Settings className="w-5 h-5 text-surface-400 dark:text-surface-500" />
          <h1 className="text-lg font-bold text-surface-900 dark:text-surface-100">Configurações</h1>
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={clsx(
                "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150",
                activeTab === id
                  ? "bg-primary-500 text-white shadow-sm"
                  : "text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-700 dark:hover:text-surface-200"
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Conteúdo */}
      <div className="flex-1 overflow-y-auto p-6">
        <SettingsPanel activeTab={activeTab} />
      </div>
    </div>
  );
};
