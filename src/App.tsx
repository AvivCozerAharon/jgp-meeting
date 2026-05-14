// App.tsx
// Componente raiz do JGP Meeting.
// Gerencia a navegação entre páginas, o estado global e o tema.
//
// IMPORTANTE: O MainPage é mantido SEMPRE montado (com display:none quando
// inativo) para preservar os hooks de captura, transcrição e seus listeners
// durante a navegação. Sem isso, navegar para Histórico/Config mataria o
// useAudioCapture e a gravação ficaria dessincronizada.

import { useState, useCallback, useEffect } from "react";
import { Navigation } from "@/components/Navigation";
import { MainPage } from "@/pages/MainPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SetupWizard } from "@/components/SetupWizard";
import type { AppPage } from "@/types";
import { useDraining } from "@/hooks/useDraining";
import { ThemeContext, useThemeProvider } from "@/hooks/useTheme";
import { getSettings } from "@/services/storageService";

function App() {
  const [currentPage, setCurrentPage] = useState<AppPage>("main");
  // Estado global de draining (transcrição pós-stop)
  const drainingState = useDraining();
  // Tema (dark/light/system)
  const themeValue = useThemeProvider();

  // Estado de gravação vindo do MainPage (via callback)
  const [isRecording, setIsRecording] = useState(false);

  // Wizard de configuração inicial
  const [showWizard, setShowWizard] = useState(false);
  useEffect(() => {
    getSettings()
      .then((s) => { if (!s.setup_done) setShowWizard(true); })
      .catch(() => {});
  }, []);

  const handleNavigate = useCallback((page: AppPage) => {
    setCurrentPage(page);
  }, []);

  const handleMeetingSaved = useCallback((meetingId: string) => {
    console.log("Reunião salva:", meetingId);
  }, []);

  return (
    <ThemeContext.Provider value={themeValue}>
      {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
      <div className="flex h-screen w-screen overflow-hidden bg-surface-50 dark:bg-[#0c0f17]">
        {/* Sidebar de navegação */}
        <Navigation
          currentPage={currentPage}
          onNavigate={handleNavigate}
          isRecording={isRecording}
          isDraining={drainingState.isDraining}
          drainingProgress={drainingState.progress}
          drainingPending={drainingState.pending}
          drainingTotal={drainingState.total}
        />

        {/* Área de conteúdo principal */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/*
            MainPage fica SEMPRE montado para preservar os hooks de captura
            e transcrição. Quando não é a página ativa, fica invisível com
            display:none (o React mantém o DOM e os hooks vivos).
          */}
          <div
            className="flex-1 flex flex-col overflow-hidden"
            style={{ display: currentPage === "main" ? "flex" : "none" }}
          >
            <MainPage
              onMeetingSaved={handleMeetingSaved}
              onRecordingChange={setIsRecording}
            />
          </div>

          {currentPage === "history" && <HistoryPage />}
          {currentPage === "settings" && <SettingsPage />}
        </main>
      </div>
    </ThemeContext.Provider>
  );
}

export default App;
