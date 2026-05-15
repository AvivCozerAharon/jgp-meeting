import { useState, useCallback, useEffect } from "react";
import { Navigation } from "@/components/Navigation";
import { MainPage } from "@/pages/MainPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SetupWizard } from "@/components/SetupWizard";
import { UpdateBanner } from "@/components/UpdateBanner";
import type { AppPage } from "@/types";
import type { Update } from "@tauri-apps/plugin-updater";
import { useDraining } from "@/hooks/useDraining";
import { ThemeContext, useThemeProvider } from "@/hooks/useTheme";
import { getSettings } from "@/services/storageService";

interface UpdateInfo {
  version: string;
  notes: string;
}

function App() {
  const [currentPage, setCurrentPage] = useState<AppPage>("main");
  const drainingState = useDraining();
  const themeValue = useThemeProvider();
  const [isRecording, setIsRecording] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<number | null>(null);
  const [updateHandle, setUpdateHandle] = useState<Update | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => { if (!s.setup_done) setShowWizard(true); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const checkUpdate = async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!cancelled && update?.available) {
          setUpdateInfo({ version: update.version, notes: update.body ?? "" });
          setUpdateHandle(update);
        }
      } catch {
        // Silent fail — no internet or update server unavailable
      }
    };
    checkUpdate();
    return () => { cancelled = true; };
  }, []);

  const handleInstall = useCallback(async () => {
    if (!updateHandle) return;
    setInstalling(true);
    setInstallProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await updateHandle.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength ?? 0;
          if (total > 0) setInstallProgress(Math.round((downloaded / total) * 100));
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      setInstalling(false);
      setInstallProgress(null);
    }
  }, [updateHandle]);

  const handleDismissUpdate = useCallback(() => {
    setUpdateInfo(null);
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
        <Navigation
          currentPage={currentPage}
          onNavigate={handleNavigate}
          isRecording={isRecording}
          isDraining={drainingState.isDraining}
          drainingProgress={drainingState.progress}
          drainingPending={drainingState.pending}
          drainingTotal={drainingState.total}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {updateInfo && (
            <UpdateBanner
              version={updateInfo.version}
              notes={updateInfo.notes}
              onInstall={handleInstall}
              onDismiss={handleDismissUpdate}
              installing={installing}
              progress={installProgress}
            />
          )}

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
