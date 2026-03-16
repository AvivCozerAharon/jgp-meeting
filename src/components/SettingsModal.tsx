// components/SettingsModal.tsx
// Modal/painel de configurações do aplicativo.
// Permite configurar a chave da API OpenAI, idioma e outros parâmetros.

import React, { useState, useEffect, useRef } from "react";
import clsx from "clsx";
import {
  Key,
  Globe,
  Cpu,
  Clock,
  Eye,
  EyeOff,
  Save,
  CheckCircle2,
  AlertCircle,
  Mic,
  Volume2,
  Laptop,
  LayoutGrid,
  FolderOpen,
  Keyboard,
  Sparkles,
  Download,
  HardDrive,
  MessageSquare,
  Link,
  Sun,
  Moon,
  Monitor,
  LogIn,
  Unplug,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, AudioDevice, MeetingType } from "@/types";
import { useTheme } from "@/hooks/useTheme";
import type { Theme } from "@/hooks/useTheme";
import { MEETING_TYPE_LABELS, MEETING_TYPE_ICONS } from "@/types";
import { getSettings, saveSettings } from "@/services/storageService";
import { Spinner } from "./LoadingSpinner";

const ALL_MEETING_TYPES: MeetingType[] = [
  'general', 'standup', 'one_on_one', 'retrospective', 'commercial', 'interview',
];

const SUPPORTED_MODELS = [
  { value: "gpt-4o-mini", label: "GPT-4o Mini (Recomendado)" },
  { value: "gpt-4o", label: "GPT-4o (Mais preciso)" },
  { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo (Mais rápido)" },
];

const SUPPORTED_LANGUAGES = [
  { value: "pt", label: "Português (pt)" },
  { value: "en", label: "English (en)" },
  { value: "es", label: "Español (es)" },
  { value: "", label: "Auto-detectar" },
];

const CHUNK_DURATIONS = [
  { value: 5, label: "5 segundos (mais rápido, mais caro)" },
  { value: 10, label: "10 segundos (Recomendado)" },
  { value: 15, label: "15 segundos" },
  { value: 30, label: "30 segundos (mais econômico)" },
];

type SettingsTab = "config" | "shortcuts" | "jgrc";

interface SettingsPanelProps {
  className?: string;
  activeTab?: SettingsTab;
}

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ElementType }[] = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Escuro", icon: Moon },
  { value: "system", label: "Sistema", icon: Monitor },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ className, activeTab = "config" }) => {
  const themeCtx = useTheme();
  const [settings, setSettings] = useState<AppSettings>({
    openai_api_key: "",
    transcription_language: "pt",
    summary_model: "gpt-4o-mini",
    chunk_duration_secs: 10,
    transcription_provider: "openai",
    groq_api_key: "",
    google_cloud_api_key: "",
    silence_threshold: 0.005,
    capture_microphone: true,
    use_local_whisper: false,
    local_whisper_exe: "",
    local_whisper_model: "base",
    default_meeting_type: "general",
    global_hotkey: "ctrl+shift+r",
    mute_mic_hotkey: "ctrl+shift+m",
    auto_summary: false,
    local_models_dir: "",
    selected_microphone: "",
    mic_auto_gain: true,
    mic_gain_max: 4,
    mic_silence_threshold: 0.003,
    mic_chunk_duration_secs: 5,
    system_auto_gain: true,
    system_gain_max: 3,
    whisper_prompt: "",
    jgrc_url: "",
    jgrc_token: "",
    jgrc_event_type_id: "",
    jgrc_responsible_id: "",
    jgrc_session_cookie: "",
    theme: "dark",
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [showKey, setShowKey] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Lista de microfones disponíveis no sistema
  const [microphones, setMicrophones] = useState<AudioDevice[]>([]);
  const [loadingMics, setLoadingMics] = useState(false);

  // Carrega as configurações ao montar
  useEffect(() => {
    getSettings()
      .then((s) => setSettings(s))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, []);

  // Carrega a lista de microfones ao montar
  useEffect(() => {
    setLoadingMics(true);
    invoke<AudioDevice[]>("list_microphones")
      .then(setMicrophones)
      .catch(console.error)
      .finally(() => setLoadingMics(false));
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus("idle");
    setSaveError(null);

    try {
      await saveSettings(settings);
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveError(String(err));
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaveStatus("idle");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className={clsx("max-w-xl space-y-6", className)}>
      {activeTab === "config" && (<>
      {/* Aparência / Tema */}
      <SettingSection
        icon={<Sun className="w-4 h-4 text-surface-500 dark:text-surface-400" />}
        title="Aparência"
        description="Escolha o tema visual do aplicativo."
      >
        <div className="flex gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => themeCtx.setTheme(value)}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium",
                "border transition-all duration-150",
                themeCtx.theme === value
                  ? "bg-primary-500 border-primary-500 text-white shadow-sm"
                  : "bg-surface-50 dark:bg-surface-800/60 border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:border-primary-400 dark:hover:border-primary-400"
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      </SettingSection>

      {/* Provider de Transcrição */}
      <SettingSection
        icon={<Cpu className="w-4 h-4 text-surface-500" />}
        title="Serviço de Transcrição"
        description="Escolha o serviço usado para transcrever o áudio. Cada um requer sua própria API key."
      >
        <select
          value={settings.transcription_provider ?? "openai"}
          onChange={(e) => updateSetting("transcription_provider", e.target.value)}
          className={clsx(
            "w-full px-3 py-2.5 text-sm rounded-xl border",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "transition-all appearance-none cursor-pointer"
          )}
        >
          <option value="openai">OpenAI Whisper (whisper-1)</option>
          <option value="groq">Groq Whisper (large-v3-turbo — rápido)</option>
          <option value="google_cloud">Google Cloud Speech-to-Text</option>
          <option value="local">Whisper Local (whisper.cpp)</option>
        </select>
      </SettingSection>

      {/* API Key — dinâmica conforme provider selecionado */}
      {(settings.transcription_provider ?? "openai") !== "local" && (
        <SettingSection
          icon={<Key className="w-4 h-4 text-surface-500" />}
          title={
            (settings.transcription_provider ?? "openai") === "groq"
              ? "Chave da API Groq"
              : (settings.transcription_provider ?? "openai") === "google_cloud"
              ? "Chave da API Google Cloud"
              : "Chave da API OpenAI"
          }
          description={
            (settings.transcription_provider ?? "openai") === "groq"
              ? "Crie uma conta gratuita em console.groq.com e gere uma API key."
              : (settings.transcription_provider ?? "openai") === "google_cloud"
              ? "Obtenha em console.cloud.google.com → APIs & Services → Credentials."
              : "Necessária para transcrição (Whisper) e resumos (GPT). Armazenada somente no seu computador."
          }
        >
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={
                (settings.transcription_provider ?? "openai") === "groq"
                  ? (settings.groq_api_key ?? "")
                  : (settings.transcription_provider ?? "openai") === "google_cloud"
                  ? (settings.google_cloud_api_key ?? "")
                  : settings.openai_api_key
              }
              onChange={(e) => {
                const provider = settings.transcription_provider ?? "openai";
                if (provider === "groq") updateSetting("groq_api_key", e.target.value);
                else if (provider === "google_cloud") updateSetting("google_cloud_api_key", e.target.value);
                else updateSetting("openai_api_key", e.target.value);
              }}
              placeholder={
                (settings.transcription_provider ?? "openai") === "groq"
                  ? "gsk_..."
                  : (settings.transcription_provider ?? "openai") === "google_cloud"
                  ? "AIza..."
                  : "sk-..."
              }
              className={clsx(
                "w-full px-3 pr-10 py-2.5 text-sm font-mono rounded-xl border",
                "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all"
              )}
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300 transition-colors"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </SettingSection>
      )}

      {/* API key OpenAI para resumos (quando provider não é OpenAI) */}
      {(settings.transcription_provider ?? "openai") !== "openai" &&
       (settings.transcription_provider ?? "openai") !== "local" && (
        <SettingSection
          icon={<Key className="w-4 h-4 text-surface-500" />}
          title="Chave da API OpenAI (Resumos)"
          description="Usada para gerar resumos com GPT. Necessária mesmo quando a transcrição usa outro serviço."
        >
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={settings.openai_api_key}
              onChange={(e) => updateSetting("openai_api_key", e.target.value)}
              placeholder="sk-..."
              className={clsx(
                "w-full px-3 pr-10 py-2.5 text-sm font-mono rounded-xl border",
                "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all"
              )}
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300 transition-colors"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </SettingSection>
      )}

      {/* Idioma da transcrição */}
      <SettingSection
        icon={<Globe className="w-4 h-4 text-surface-500" />}
        title="Idioma da Transcrição"
        description="Definir o idioma melhora a precisão do Whisper."
      >
        <select
          value={settings.transcription_language}
          onChange={(e) => updateSetting("transcription_language", e.target.value)}
          className={clsx(
            "w-full px-3 py-2.5 text-sm rounded-xl border",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "transition-all appearance-none cursor-pointer"
          )}
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </SettingSection>

      {/* Modelo GPT */}
      <SettingSection
        icon={<Cpu className="w-4 h-4 text-surface-500" />}
        title="Modelo para Resumos"
        description="Modelos mais avançados geram resumos melhores, mas custam mais."
      >
        <select
          value={settings.summary_model}
          onChange={(e) => updateSetting("summary_model", e.target.value)}
          className={clsx(
            "w-full px-3 py-2.5 text-sm rounded-xl border",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "transition-all appearance-none cursor-pointer"
          )}
        >
          {SUPPORTED_MODELS.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
      </SettingSection>

      {/* Duração do chunk */}
      <SettingSection
        icon={<Clock className="w-4 h-4 text-surface-500" />}
        title="Intervalo de Transcrição"
        description="Frequência com que o áudio é enviado para transcrição. Valores menores = mais rápido, mas mais chamadas de API."
      >
        <select
          value={settings.chunk_duration_secs}
          onChange={(e) => updateSetting("chunk_duration_secs", Number(e.target.value))}
          className={clsx(
            "w-full px-3 py-2.5 text-sm rounded-xl border",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "transition-all appearance-none cursor-pointer"
          )}
        >
          {CHUNK_DURATIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </SettingSection>

      {/* Feature 1: Threshold de silêncio */}
      <SettingSection
        icon={<Volume2 className="w-4 h-4 text-surface-500" />}
        title="Sensibilidade ao Silêncio"
        description={`Chunks com volume abaixo desse valor são descartados (não enviados ao Whisper). Valor atual: ${settings.silence_threshold?.toFixed(3) ?? '0.005'}`}
      >
        <input
          type="range"
          min={0.001}
          max={0.05}
          step={0.001}
          value={settings.silence_threshold ?? 0.005}
          onChange={(e) => updateSetting("silence_threshold", parseFloat(e.target.value))}
          className="w-full accent-primary-500"
        />
        <div className="flex justify-between text-[10px] text-surface-400 dark:text-surface-500 mt-1">
          <span>Mais sensível</span>
          <span>Menos sensível</span>
        </div>
      </SettingSection>

      {/* Feature 5: Captura de microfone */}
      <SettingSection
        icon={<Mic className="w-4 h-4 text-surface-500" />}
        title="Capturar Microfone"
        description="Mistura o áudio do microfone com o áudio do sistema na transcrição."
      >
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => updateSetting("capture_microphone", !settings.capture_microphone)}
            className={clsx(
              "relative w-10 h-5 rounded-full transition-colors duration-200 cursor-pointer",
              settings.capture_microphone ? "bg-primary-500" : "bg-surface-200 dark:bg-surface-600"
            )}
          >
            <span
              className={clsx(
                "absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200",
                settings.capture_microphone ? "translate-x-5" : "translate-x-0"
              )}
            />
          </div>
          <span className="text-sm text-surface-700 dark:text-surface-300">
            {settings.capture_microphone ? "Ativado" : "Desativado"}
          </span>
        </label>

        {/* Seletor de microfone — aparece sempre para facilitar a seleção */}
        <div className="mt-3">
          <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1.5 flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5" />
            Dispositivo de entrada
            {loadingMics && <span className="text-surface-400 font-normal">(carregando…)</span>}
          </label>

          {microphones.length === 0 && !loadingMics ? (
            <p className="text-xs text-surface-400 dark:text-surface-500 italic">Nenhum microfone detectado.</p>
          ) : (
            <select
              value={settings.selected_microphone ?? ""}
              onChange={(e) => updateSetting("selected_microphone", e.target.value)}
              disabled={loadingMics}
              className={clsx(
                "w-full px-3 py-2 text-sm rounded-xl border",
                "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                loadingMics && "opacity-50 cursor-not-allowed"
              )}
            >
              {microphones.map((mic) => (
                <option key={mic.id} value={mic.id}>
                  {mic.name}
                </option>
              ))}
            </select>
          )}

          {settings.selected_microphone && (
            <button
              type="button"
              onClick={() => updateSetting("selected_microphone", "")}
              className="mt-1 text-xs text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300 underline"
            >
              Usar microfone padrão do sistema
            </button>
          )}
        </div>

        {/* ── Configurações avançadas do microfone ── */}
        {settings.capture_microphone && (
          <div className="mt-4 space-y-3 pl-3 border-l-2 border-emerald-200 dark:border-emerald-500/30">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-surface-400 dark:text-surface-500">
              Qualidade do microfone
            </p>

            {/* AGC toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-surface-700 dark:text-surface-300">Ganho Automático (AGC)</p>
                <p className="text-[10px] text-surface-400 dark:text-surface-500">Amplifica o volume do mic automaticamente</p>
              </div>
              <div
                onClick={() => updateSetting("mic_auto_gain", !settings.mic_auto_gain)}
                className={clsx(
                  "relative w-9 h-[18px] rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0",
                  settings.mic_auto_gain ? "bg-emerald-500" : "bg-surface-200 dark:bg-surface-600"
                )}
              >
                <span
                  className={clsx(
                    "absolute top-[2px] left-[2px] w-3.5 h-3.5 bg-white rounded-full shadow transition-transform duration-200",
                    settings.mic_auto_gain ? "translate-x-[18px]" : "translate-x-0"
                  )}
                />
              </div>
            </div>

            {/* Ganho máximo (só quando AGC ativo) */}
            {settings.mic_auto_gain && (
              <div>
                <p className="text-xs font-medium text-surface-700 dark:text-surface-300 mb-1">
                  Ganho máximo: {settings.mic_gain_max?.toFixed(1) ?? '4.0'}x
                </p>
                <input
                  type="range"
                  min={1.5}
                  max={10}
                  step={0.5}
                  value={settings.mic_gain_max ?? 4}
                  onChange={(e) => updateSetting("mic_gain_max", parseFloat(e.target.value))}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-[10px] text-surface-400 dark:text-surface-500 mt-0.5">
                  <span>1.5x (sutil)</span>
                  <span>10x (máximo)</span>
                </div>
              </div>
            )}

            {/* Sensibilidade ao silêncio do mic */}
            <div>
              <p className="text-xs font-medium text-surface-700 dark:text-surface-300 mb-1">
                Sensibilidade do mic: {settings.mic_silence_threshold?.toFixed(3) ?? '0.003'}
              </p>
              <input
                type="range"
                min={0.001}
                max={0.03}
                step={0.001}
                value={settings.mic_silence_threshold ?? 0.003}
                onChange={(e) => updateSetting("mic_silence_threshold", parseFloat(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-[10px] text-surface-400 dark:text-surface-500 mt-0.5">
                <span>Mais sensível</span>
                <span>Menos sensível</span>
              </div>
            </div>

            {/* Intervalo de transcrição do mic */}
            <div>
              <p className="text-xs font-medium text-surface-700 dark:text-surface-300 mb-1">
                Intervalo do mic
              </p>
              <select
                value={settings.mic_chunk_duration_secs ?? 5}
                onChange={(e) => updateSetting("mic_chunk_duration_secs", Number(e.target.value))}
                className={clsx(
                  "w-full px-3 py-1.5 text-xs rounded-lg border",
                  "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                  "focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent",
                  "transition-all appearance-none cursor-pointer"
                )}
              >
                <option value={3}>3 segundos (mais rápido)</option>
                <option value={5}>5 segundos (recomendado)</option>
                <option value={8}>8 segundos</option>
                <option value={10}>10 segundos (igual ao sistema)</option>
              </select>
              <p className="text-[10px] text-surface-400 dark:text-surface-500 mt-0.5">
                Chunks menores = menos ruído por envio = transcrição mais precisa
              </p>
            </div>
          </div>
        )}
      </SettingSection>

      {/* Prompt de contexto Whisper */}
      <SettingSection
        icon={<MessageSquare className="w-4 h-4 text-surface-500" />}
        title="Prompt de Contexto (Whisper)"
        description="Texto de contexto enviado ao Whisper para melhorar a transcrição. Inclua nomes de pessoas, empresas, termos técnicos ou jargão relevante."
      >
        <textarea
          value={settings.whisper_prompt ?? ""}
          onChange={(e) => updateSetting("whisper_prompt", e.target.value)}
          rows={2}
          placeholder="Ex: Reunião de investimentos da JGP. Participantes: André, Marcelo, Guilherme. Termos: CDI, FIC FIM, cota, benchmark."
          className={clsx(
            "w-full px-3 py-2 text-sm rounded-xl border resize-none",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "placeholder:text-surface-400 dark:placeholder:text-surface-600",
            "transition-all"
          )}
        />
      </SettingSection>

      {/* Feature 7: Whisper local (só aparece quando provider é "local") */}
      {(settings.transcription_provider ?? "openai") === "local" && (
      <SettingSection
        icon={<Laptop className="w-4 h-4 text-surface-500" />}
        title="Configuração do Whisper Local"
        description="Configure o executável whisper-cli.exe e o modelo ggml para transcrição local."
      >
          <div className="space-y-3">
            {/* Aviso sobre o exe */}
            <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg text-xs text-amber-800 dark:text-amber-300">
              <span className="mt-0.5">⚠️</span>
              <span>
                Baixe o <strong>whisper-cli.exe</strong> em{" "}
                <a
                  href="https://github.com/ggerganov/whisper.cpp/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium"
                >
                  github.com/ggerganov/whisper.cpp/releases
                </a>
                {" "}e configure o caminho abaixo. O modelo .bin é baixado pela seção abaixo.
              </span>
            </div>

            <div>
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1 block flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5" />
                Executável whisper-cli.exe
              </label>
              <input
                type="text"
                value={settings.local_whisper_exe ?? ""}
                onChange={(e) => updateSetting("local_whisper_exe", e.target.value)}
                placeholder="C:\whisper\whisper-cli.exe"
                className={clsx(
                  "w-full px-3 py-2 text-sm rounded-xl border",
                  "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                  "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                  "placeholder:text-surface-300 dark:placeholder:text-surface-600 font-mono",
                  settings.local_whisper_exe?.endsWith(".bin") && "border-red-400 bg-red-50 dark:border-red-500/50 dark:bg-red-500/10"
                )}
              />
              {settings.local_whisper_exe?.endsWith(".bin") && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                  ⚠️ Este campo deve apontar para o <strong>whisper-cli.exe</strong>, não para o arquivo .bin do modelo.
                </p>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1 block flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5" />
                Caminho do modelo (.bin)
                <span className="text-primary-500 font-normal">(auto-preenchido ao baixar)</span>
              </label>
              <input
                type="text"
                value={settings.local_whisper_model ?? "base"}
                onChange={(e) => updateSetting("local_whisper_model", e.target.value)}
                placeholder="base  ou  C:\...\ggml-base.bin"
                className={clsx(
                  "w-full px-3 py-2 text-sm rounded-xl border",
                  "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                  "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                  "placeholder:text-surface-300 dark:placeholder:text-surface-600 font-mono"
                )}
              />
            </div>
          </div>
      </SettingSection>
      )}

      {/* Feature 8: Tipo de reunião padrão */}
      <SettingSection
        icon={<LayoutGrid className="w-4 h-4 text-surface-500" />}
        title="Tipo de Reunião Padrão"
        description="Tipo pré-selecionado ao iniciar uma nova gravação."
      >
        <div className="flex flex-wrap gap-1.5">
          {ALL_MEETING_TYPES.map((type) => {
            const isActive = (settings.default_meeting_type ?? 'general') === type;
            return (
              <button
                key={type}
                onClick={() => updateSetting("default_meeting_type", type)}
                className={clsx(
                  "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium",
                  "border transition-all duration-150",
                  isActive
                    ? "bg-primary-500 border-primary-500 text-white shadow-sm"
                    : "bg-surface-50 dark:bg-surface-800/60 border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:border-primary-400 dark:hover:border-primary-400 hover:text-primary-600 dark:hover:text-primary-400"
                )}
              >
                <span>{MEETING_TYPE_ICONS[type]}</span>
                <span>{MEETING_TYPE_LABELS[type]}</span>
              </button>
            );
          })}
        </div>
      </SettingSection>

      {/* Feature 15: Auto-resumo */}
      <SettingSection
        icon={<Sparkles className="w-4 h-4 text-surface-500" />}
        title="Auto-Resumo"
        description="Gera o resumo automaticamente assim que a gravação for parada (requer chave da API configurada)."
      >
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => updateSetting("auto_summary", !settings.auto_summary)}
            className={clsx(
              "relative w-10 h-5 rounded-full transition-colors duration-200 cursor-pointer",
              settings.auto_summary ? "bg-primary-500" : "bg-surface-200 dark:bg-surface-600"
            )}
          >
            <span
              className={clsx(
                "absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200",
                settings.auto_summary ? "translate-x-5" : "translate-x-0"
              )}
            />
          </div>
          <span className="text-sm text-surface-700 dark:text-surface-300">
            {settings.auto_summary ? "Ativado" : "Desativado"}
          </span>
        </label>
      </SettingSection>

      {/* Download de modelo Whisper */}
      <WhisperModelDownloader onModelDownloaded={(path) => updateSetting("local_whisper_model", path)} />

      </>)}

      {activeTab === "jgrc" && (<>
      {/* Integração JGRC */}
      <JgrcConnectionSection
        jgrcSessionCookie={settings.jgrc_session_cookie ?? ""}
        onSessionCookie={(cookie) => updateSetting("jgrc_session_cookie", cookie)}
      />
      </>)}

      {activeTab === "shortcuts" && (<>
      {/* Feature 13: Atalho global */}
      <SettingSection
        icon={<Keyboard className="w-4 h-4 text-surface-500" />}
        title="Atalho Global"
        description="Atalho de teclado global para iniciar/parar a gravação mesmo com o app em segundo plano. Salve e reinicie o app para aplicar."
      >
        <input
          type="text"
          value={settings.global_hotkey ?? "ctrl+shift+r"}
          onChange={(e) => updateSetting("global_hotkey", e.target.value)}
          placeholder="ctrl+shift+r"
          className={clsx(
            "w-full px-3 py-2.5 text-sm rounded-xl border font-mono",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "placeholder:text-surface-300 dark:placeholder:text-surface-600"
          )}
        />
        <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
          Exemplos: ctrl+shift+r · alt+shift+m · ctrl+alt+r
        </p>
      </SettingSection>

      {/* Atalho Mutar/Desmutar Microfone */}
      <SettingSection
        icon={<Mic className="w-4 h-4 text-surface-500" />}
        title="Mutar/Desmutar Microfone"
        description="Atalho global para mutar ou desmutar o microfone durante a gravação."
      >
        <input
          type="text"
          value={settings.mute_mic_hotkey ?? "ctrl+shift+m"}
          onChange={(e) => updateSetting("mute_mic_hotkey", e.target.value)}
          placeholder="ctrl+shift+m"
          className={clsx(
            "w-full px-3 py-2.5 text-sm rounded-xl border font-mono",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "placeholder:text-surface-300 dark:placeholder:text-surface-600"
          )}
        />
        <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
          Exemplos: ctrl+shift+m · alt+m · ctrl+alt+m
        </p>
      </SettingSection>
      </>)}

      {/* Botão Salvar */}
      <div className="flex items-center justify-between pt-2">
        <div>
          {saveStatus === "success" && (
            <p className="text-sm text-primary-600 dark:text-primary-400 flex items-center gap-1.5 animate-fade-in">
              <CheckCircle2 className="w-4 h-4" />
              Configurações salvas!
            </p>
          )}
          {saveStatus === "error" && saveError && (
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4" />
              {saveError}
            </p>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving}
          className={clsx(
            "flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold",
            "bg-primary-500 text-white shadow-sm",
            "hover:bg-primary-600 hover:shadow transition-all duration-150",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-surface-800",
            "disabled:opacity-60 disabled:cursor-not-allowed"
          )}
        >
          {isSaving ? (
            <>
              <Spinner size="xs" color="white" />
              Salvando...
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Salvar
            </>
          )}
        </button>
      </div>
    </div>
  );
};

// ─── Sub-componentes ──────────────────────────────────────────────────────────

interface SettingSectionProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}

const SettingSection: React.FC<SettingSectionProps> = ({
  icon,
  title,
  description,
  children,
}) => (
  <div className="space-y-2 p-4 rounded-xl bg-white dark:bg-surface-800/40 border border-surface-100 dark:border-surface-700/50">
    <div className="flex items-center gap-2">
      {icon}
      <label className="text-sm font-semibold text-surface-700 dark:text-surface-200">{title}</label>
    </div>
    {description && (
      <p className="text-xs text-surface-500 dark:text-surface-400 leading-relaxed">{description}</p>
    )}
    {children}
  </div>
);

// ─── Componente de conexão JGRC ───────────────────────────────────────────────

const JGRC_URL = "https://jgrc.jgp.com.br";

interface JgrcConnectionSectionProps {
  jgrcSessionCookie: string;
  onSessionCookie: (cookie: string) => void;
}

const JgrcConnectionSection: React.FC<JgrcConnectionSectionProps> = ({
  jgrcSessionCookie,
  onSessionCookie,
}) => {
  const [checkingSession, setCheckingSession] = useState(false);
  const [sessionValid, setSessionValid] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConnected = !!jgrcSessionCookie;

  // Verifica se a sessão ainda é válida
  const checkSession = async () => {
    if (!jgrcSessionCookie) return;
    setCheckingSession(true);
    try {
      const valid = await invoke<boolean>("jgrc_check_session", {
        url: JGRC_URL,
        cookie: jgrcSessionCookie,
      });
      setSessionValid(valid);
    } catch {
      console.log("Erro ao verificar sessão JGRC, assumindo inválida");
      setSessionValid(false);
    } finally {
      setCheckingSession(false);
    }
  };

  useEffect(() => {
    if (isConnected) {
      checkSession();
    }
  }, [jgrcSessionCookie]);

  const handleDisconnect = () => {
    onSessionCookie("");
    setSessionValid(null);
    setError(null);
  };

  // Abre janela Tauri para login no JGRC
  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const cookie = await invoke<string>("jgrc_open_login", { url: JGRC_URL });
      if (cookie) {
        onSessionCookie(cookie);
      }
    } catch (err) {
      console.error("Erro ao abrir login JGRC:", err);
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <SettingSection
      icon={<Link className="w-4 h-4 text-surface-500" />}
      title="Integração JGRC"
      description="Conecte-se ao JGRC para exportar reuniões como eventos."
    >
      <div className="space-y-3">
        {/* Status da conexão */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={clsx(
                "w-2.5 h-2.5 rounded-full",
                isConnected && sessionValid !== false
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-surface-300 dark:bg-surface-600"
              )}
            />
            <span className="text-xs font-medium text-surface-600 dark:text-surface-400">
              {checkingSession
                ? "Verificando..."
                : isConnected && sessionValid !== false
                ? "Conectado ao JGRC"
                : isConnected && sessionValid === false
                ? "Sessão expirada"
                : "Desconectado"}
            </span>
          </div>

          <div className="flex gap-2">
            {isConnected && (
              <button
                onClick={handleDisconnect}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
              >
                <Unplug className="w-3.5 h-3.5" />
                Desconectar
              </button>
            )}
            <button
              onClick={handleConnect}
              disabled={connecting}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
                "bg-primary-500 text-white hover:bg-primary-600 shadow-sm",
                "disabled:opacity-60 disabled:cursor-not-allowed"
              )}
            >
              {connecting ? (
                <Spinner size="xs" color="white" />
              ) : (
                <LogIn className="w-3.5 h-3.5" />
              )}
              {connecting ? "Conectando..." : isConnected ? "Reconectar" : "Conectar JGRC"}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-1.5 p-2 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg">
            <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}
      </div>
    </SettingSection>
  );
};

// ─── Componente de download de modelos Whisper ────────────────────────────────

const WHISPER_MODELS = [
  { value: "tiny",      label: "Tiny (~75 MB)",   desc: "Mais rápido, menos preciso" },
  { value: "base",      label: "Base (~142 MB)",   desc: "Bom equilíbrio (recomendado)" },
  { value: "small",     label: "Small (~466 MB)",  desc: "Mais preciso" },
  { value: "medium",    label: "Medium (~1.5 GB)", desc: "Alta precisão" },
  { value: "large-v3",  label: "Large v3 (~3 GB)", desc: "Melhor qualidade" },
];

interface DownloadProgressState {
  downloaded: number;
  total: number;
}

const WhisperModelDownloader: React.FC<{ onModelDownloaded?: (path: string) => void }> = ({ onModelDownloaded }) => {
  const [selectedModel, setSelectedModel] = useState("base");
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgressState | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    invoke<string[]>("list_downloaded_whisper_models")
      .then(setDownloadedModels)
      .catch(console.error);
  }, []);

  const handleDownload = async () => {
    setDownloading(true);
    setProgress(null);
    setDownloadError(null);
    setDownloadedPath(null);

    // Escuta progresso
    const unlisten = await listen<{ model: string; downloaded: number; total: number }>(
      "whisper-download-progress",
      (e) => setProgress({ downloaded: e.payload.downloaded, total: e.payload.total })
    );
    unlistenRef.current = unlisten;

    try {
      const path = await invoke<string>("download_whisper_model", { model: selectedModel });
      setDownloadedPath(path);
      setDownloadedModels((prev) => [...new Set([...prev, selectedModel])]);
      // Atualiza local_whisper_model com o caminho completo do modelo baixado
      onModelDownloaded?.(path);
    } catch (err) {
      setDownloadError(String(err));
    } finally {
      setDownloading(false);
      unlistenRef.current?.();
    }
  };

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : 0;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <SettingSection
      icon={<HardDrive className="w-4 h-4 text-surface-500" />}
      title="Baixar Modelo Whisper Local"
      description="Baixa modelos ggml do whisper.cpp para uso offline (sem API OpenAI). O arquivo é salvo no diretório de dados do app."
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={downloading}
            className={clsx(
              "flex-1 px-3 py-2 text-sm rounded-xl border",
              "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
              "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
              "appearance-none cursor-pointer disabled:opacity-60"
            )}
          >
            {WHISPER_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label} — {m.desc}
                {downloadedModels.includes(m.value) ? " ✓" : ""}
              </option>
            ))}
          </select>

          <button
            onClick={handleDownload}
            disabled={downloading || downloadedModels.includes(selectedModel)}
            className={clsx(
              "flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold",
              "bg-primary-500 text-white shadow-sm",
              "hover:bg-primary-600 transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-primary-500",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            {downloading ? (
              <Spinner size="xs" color="white" />
            ) : downloadedModels.includes(selectedModel) ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {downloading
              ? `${progressPct}%`
              : downloadedModels.includes(selectedModel)
              ? "Baixado"
              : "Baixar"}
          </button>
        </div>

        {/* Barra de progresso */}
        {downloading && progress && (
          <div className="space-y-1">
            <div className="w-full bg-surface-100 dark:bg-surface-700 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 bg-primary-500 rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-xs text-surface-500">
              {formatBytes(progress.downloaded)} / {progress.total > 0 ? formatBytes(progress.total) : "?"}
              {" "}— {progressPct}%
            </p>
          </div>
        )}

        {downloadError && (
          <div className="flex items-start gap-1.5 p-2 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg">
            <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-red-700 dark:text-red-400">{downloadError}</p>
          </div>
        )}

        {downloadedPath && !downloading && (
          <div className="flex items-start gap-1.5 p-2 bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/20 rounded-lg">
            <CheckCircle2 className="w-3.5 h-3.5 text-primary-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-primary-700 dark:text-primary-400 font-mono break-all">{downloadedPath}</p>
          </div>
        )}

        {downloadedModels.length > 0 && (
          <p className="text-xs text-surface-400">
            Baixados: {downloadedModels.join(", ")}
          </p>
        )}
      </div>
    </SettingSection>
  );
};
