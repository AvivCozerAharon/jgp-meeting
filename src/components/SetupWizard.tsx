// components/SetupWizard.tsx
// Wizard de configuração inicial — exibido na primeira execução do app.

import React, { useState, useCallback } from "react";
import clsx from "clsx";
import {
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  Check,
  Link,
  ChevronLeft,
  ChevronRight,
  Mic,
  Pause,
  Square,
  Tag,
  Upload,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, saveSettings } from "@/services/storageService";
import type { AppSettings } from "@/types";
import jgpLogo from "../assets/marca-jgp-white.png";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface SetupWizardProps {
  onComplete: () => void;
}

type Provider = "openai" | "openrouter" | "groq";

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
};

const PROVIDER_DESCRIPTIONS: Record<Provider, string> = {
  openai: "GPT-4o para resumos, Whisper para transcrição",
  openrouter: "Acesso a múltiplos modelos com uma chave só",
  groq: "Transcrição rápida e gratuita com Whisper",
};

const PROVIDER_KEY_PLACEHOLDER: Record<Provider, string> = {
  openai: "sk-...",
  openrouter: "sk-or-...",
  groq: "gsk_...",
};

// ─── Ilustrações do tour ──────────────────────────────────────────────────────

const IllustrationTranscription: React.FC = () => (
  <div className="flex flex-col gap-2 px-4 py-3">
    {[
      { side: "left", color: "emerald", label: "Você", text: "Vamos alinhar os pontos da semana..." },
      { side: "right", color: "blue", label: "Reunião", text: "Concordo. Começando pela meta de Q2." },
      { side: "left", color: "emerald", label: "Você", text: "Perfeito", cursor: true },
    ].map((b, i) => (
      <div key={i} className={clsx("flex gap-2 items-start", b.side === "right" && "flex-row-reverse")}>
        <div className={clsx(
          "w-5 h-5 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center",
          b.color === "emerald" ? "bg-emerald-100 dark:bg-emerald-500/20" : "bg-blue-100 dark:bg-blue-500/20"
        )}>
          {b.color === "emerald"
            ? <Mic className="w-2.5 h-2.5 text-emerald-500" />
            : <span className="text-[8px] text-blue-500 font-bold">R</span>}
        </div>
        <div className={clsx(
          "rounded-xl px-3 py-1.5 text-xs max-w-[75%]",
          b.color === "emerald"
            ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-500/20"
            : "bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-500/20"
        )}>
          {b.text}
          {b.cursor && (
            <span className="inline-block w-0.5 h-3 bg-primary-500 ml-0.5 align-middle animate-pulse" />
          )}
        </div>
      </div>
    ))}
  </div>
);

const IllustrationOverlay: React.FC = () => (
  <div className="flex items-center justify-center py-4">
    <div style={{
      padding: "0 12px",
      height: 40,
      borderRadius: 20,
      display: "flex",
      alignItems: "center",
      gap: 8,
      background: "rgba(22,22,24,0.88)",
      border: "1px solid rgba(255,255,255,0.09)",
      boxShadow: "0 4px 24px rgba(0,0,0,0.30)",
    }}>
      <img src={jgpLogo} alt="JGP" style={{ height: 14, opacity: 0.85 }} />
      <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.12)" }} />
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "1px 6px 1px 5px", borderRadius: 6,
        background: "rgba(239,68,68,0.18)", border: "1px solid rgba(239,68,68,0.3)",
      }}>
        <span style={{
          display: "block", width: 6, height: 6, borderRadius: "50%",
          background: "#ef4444", animation: "rec-pulse 1.4s cubic-bezier(0.4,0,0.6,1) infinite",
        }} />
        <span style={{ fontSize: 9, fontWeight: 700, color: "#ef4444", letterSpacing: "0.08em" }}>REC</span>
      </div>
      <span style={{ fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,0.80)", fontFamily: "monospace" }}>02:34</span>
      <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.12)" }} />
      <div style={{ display: "flex", gap: 3 }}>
        {[Mic, Pause, Square].map((Icon, i) => (
          <div key={i} style={{
            width: 22, height: 22, borderRadius: 11,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: i === 2 ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.06)",
            border: `1px solid ${i === 2 ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.08)"}`,
          }}>
            <Icon size={i === 2 ? 8 : 10} color={i === 2 ? "rgba(239,68,68,0.85)" : "rgba(255,255,255,0.6)"} strokeWidth={i === 2 ? 0 : 2} fill={i === 2 ? "rgba(239,68,68,0.85)" : "none"} />
          </div>
        ))}
      </div>
    </div>
  </div>
);

const IllustrationTags: React.FC = () => (
  <div className="flex flex-col gap-2 px-4 py-3">
    {[
      { title: "Alinhamento Q2 — Produto", tags: [{ label: "produto", color: "#6366f1" }, { label: "estratégia", color: "#0ea5e9" }] },
      { title: "1:1 Design — Sprint Review", tags: [{ label: "design", color: "#ec4899" }, { label: "recorrente", color: "#f59e0b" }] },
    ].map((m, i) => (
      <div key={i} className="flex items-center justify-between px-3 py-2 rounded-xl bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700 shadow-sm">
        <span className="text-xs font-medium text-surface-700 dark:text-surface-200 truncate mr-3">{m.title}</span>
        <div className="flex gap-1 flex-shrink-0">
          {m.tags.map((t) => (
            <div key={t.label} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white" style={{ backgroundColor: t.color }}>
              <Tag className="w-2.5 h-2.5" />
              {t.label}
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
);

const IllustrationExport: React.FC = () => {
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-3">
      <div className="px-3 py-2 rounded-xl bg-white dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700 shadow-sm w-56">
        <p className="text-xs font-medium text-surface-700 dark:text-surface-200 mb-0.5">Reunião de Diretoria</p>
        <p className="text-[10px] text-surface-400">45 min · 3 participantes</p>
      </div>
      <button
        onClick={() => setDone(true)}
        className={clsx(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-300",
          done
            ? "bg-emerald-500 text-white"
            : "bg-primary-500 hover:bg-primary-600 text-white"
        )}
      >
        {done ? <><Check className="w-3.5 h-3.5" /> Exportado!</> : <><Upload className="w-3.5 h-3.5" /> Exportar para JGRC</>}
      </button>
      {done && (
        <p className="text-[10px] text-emerald-600 dark:text-emerald-400 animate-pulse">
          Evento criado no JGRC ✓
        </p>
      )}
    </div>
  );
};

// ─── Tour slides ──────────────────────────────────────────────────────────────

interface TourSlideData {
  title: string;
  description: string;
  Illustration: React.FC;
}

const TOUR_SLIDES: TourSlideData[] = [
  {
    title: "Transcrição em tempo real",
    description: "Mic e áudio do sistema são transcritos separadamente, identificando quem fala.",
    Illustration: IllustrationTranscription,
  },
  {
    title: "Overlay de compliance",
    description: "Uma pill flutuante aparece durante a gravação com controles de pause, mute e stop.",
    Illustration: IllustrationOverlay,
  },
  {
    title: "Tags nas reuniões",
    description: "Organize suas reuniões com tags coloridas e filtre o histórico por categoria.",
    Illustration: IllustrationTags,
  },
  {
    title: "Exportação para o JGRC",
    description: "Envie a transcrição e o resumo para o JGRC com um clique, sem copiar nada.",
    Illustration: IllustrationExport,
  },
];

const TourStep: React.FC = () => {
  const [slide, setSlide] = useState(0);
  const total = TOUR_SLIDES.length;
  const { title, description, Illustration } = TOUR_SLIDES[slide];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-1">
          O que o JGP Meeting faz
        </h2>
        <p className="text-sm text-surface-500 dark:text-surface-400">
          Veja as principais features antes de configurar.
        </p>
      </div>

      {/* Slide container */}
      <div className="rounded-xl border border-surface-100 dark:border-surface-700 bg-surface-50/50 dark:bg-surface-800/30 overflow-hidden min-h-[160px] flex items-center">
        <Illustration />
      </div>

      {/* Slide info + nav */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setSlide((s) => Math.max(0, s - 1))}
          disabled={slide === 0}
          className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 text-center">
          <p className="text-sm font-semibold text-surface-800 dark:text-surface-100">{title}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5 leading-relaxed">{description}</p>
        </div>

        <button
          onClick={() => setSlide((s) => Math.min(total - 1, s + 1))}
          disabled={slide === total - 1}
          className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Dots */}
      <div className="flex items-center justify-center gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
          <button
            key={i}
            onClick={() => setSlide(i)}
            className={clsx(
              "rounded-full transition-all duration-200",
              i === slide
                ? "w-4 h-1.5 bg-primary-500"
                : "w-1.5 h-1.5 bg-surface-300 dark:bg-surface-600 hover:bg-surface-400"
            )}
          />
        ))}
      </div>
    </div>
  );
};

// ─── Step indicator ───────────────────────────────────────────────────────────

const StepIndicator: React.FC<{ current: number; total: number }> = ({ current, total }) => (
  <div className="flex items-center gap-2">
    {Array.from({ length: total }).map((_, i) => (
      <div
        key={i}
        className={clsx(
          "h-1.5 rounded-full transition-all duration-300",
          i < current
            ? "w-6 bg-primary-500"
            : i === current
            ? "w-8 bg-primary-500"
            : "w-4 bg-surface-200 dark:bg-surface-700"
        )}
      />
    ))}
  </div>
);

// ─── Wizard ──────────────────────────────────────────────────────────────────

export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const [step, setStep] = useState(0);
  const TOTAL_STEPS = 5;

  // Step 2 — API
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<"idle" | "ok" | "error">("idle");
  const [keyError, setKeyError] = useState("");

  // Step 3 — JGRC
  const [jgrcConnected, setJgrcConnected] = useState(false);

  const [saving, setSaving] = useState(false);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const testApiKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setTestingKey(true);
    setKeyStatus("idle");
    setKeyError("");
    try {
      const endpoint =
        provider === "openrouter"
          ? "https://openrouter.ai/api/v1/models"
          : provider === "groq"
          ? "https://api.groq.com/openai/v1/models"
          : "https://api.openai.com/v1/models";
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
      if (res.ok) {
        setKeyStatus("ok");
      } else {
        setKeyStatus("error");
        setKeyError(res.status === 401 ? "Chave inválida ou sem permissão" : `Erro ${res.status}`);
      }
    } catch {
      setKeyStatus("error");
      setKeyError("Não foi possível conectar. Verifique sua internet.");
    } finally {
      setTestingKey(false);
    }
  }, [apiKey, provider]);

  const handleJgrcLogin = useCallback(async () => {
    try {
      const settings = await getSettings();
      const url = settings.jgrc_url || "https://jgrc.jgp.com.br";
      await invoke("jgrc_open_login", { url });
      const updated = await getSettings();
      if (updated.jgrc_session_cookie) setJgrcConnected(true);
    } catch (e) {
      console.error("JGRC login:", e);
    }
  }, []);

  const handleComplete = useCallback(async () => {
    setSaving(true);
    try {
      const current = await getSettings();
      const updated: Partial<AppSettings> = { ...current, setup_done: true };
      if (apiKey.trim()) {
        if (provider === "openai") {
          updated.openai_api_key = apiKey.trim();
          updated.transcription_provider = "openai";
          updated.summary_provider = "openai";
        } else if (provider === "openrouter") {
          updated.openrouter_api_key = apiKey.trim();
          updated.summary_provider = "openrouter";
          updated.transcription_provider = "openai";
        } else if (provider === "groq") {
          updated.groq_api_key = apiKey.trim();
          updated.transcription_provider = "groq";
        }
      }
      await saveSettings(updated as AppSettings);
      onComplete();
    } catch (e) {
      console.error("Erro ao salvar configurações:", e);
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider, onComplete]);

  // ── Render por step ──────────────────────────────────────────────────────────

  const renderStep = () => {
    switch (step) {
      // ── Step 0: Boas-vindas ────────────────────────────────────────────────
      case 0:
        return (
          <div className="flex flex-col items-center text-center gap-6 py-4">
            <div className="w-20 h-20 rounded-2xl bg-surface-900 dark:bg-surface-800 flex items-center justify-center shadow-lg">
              <img src={jgpLogo} alt="JGP" className="h-8 w-auto" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-surface-900 dark:text-surface-100 mb-2">
                JGP Meeting
              </h2>
              <p className="text-sm text-surface-500 dark:text-surface-400 max-w-sm leading-relaxed">
                Grave suas reuniões, transcreva automaticamente e exporte para o JGRC — tudo sem sair do computador.
              </p>
            </div>
            <p className="text-xs text-surface-400 dark:text-surface-500">
              Configuração leva menos de 2 minutos. Você pode pular qualquer etapa.
            </p>
          </div>
        );

      // ── Step 1: Tour ───────────────────────────────────────────────────────
      case 1:
        return <TourStep />;

      // ── Step 2: API Key ────────────────────────────────────────────────────
      case 2:
        return (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-1">
                Conectar IA
              </h2>
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Escolha o provedor e insira sua chave de API.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(["openai", "openrouter", "groq"] as Provider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => { setProvider(p); setKeyStatus("idle"); }}
                  className={clsx(
                    "flex flex-col items-center gap-1.5 p-3 rounded-xl border text-left transition-all",
                    provider === p
                      ? "border-primary-500 bg-primary-50 dark:bg-primary-500/10"
                      : "border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600 bg-white dark:bg-surface-800/40"
                  )}
                >
                  <span className={clsx("text-sm font-semibold", provider === p ? "text-primary-600 dark:text-primary-400" : "text-surface-700 dark:text-surface-200")}>
                    {PROVIDER_LABELS[p]}
                  </span>
                  <span className="text-[10px] text-surface-400 dark:text-surface-500 text-center leading-tight">
                    {PROVIDER_DESCRIPTIONS[p]}
                  </span>
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-surface-600 dark:text-surface-400">
                Chave de API — {PROVIDER_LABELS[provider]}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setKeyStatus("idle"); }}
                    placeholder={PROVIDER_KEY_PLACEHOLDER[provider]}
                    className={clsx(
                      "w-full px-3 py-2 pr-9 text-sm rounded-xl border",
                      "bg-white dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
                      "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                      keyStatus === "ok" ? "border-emerald-400 dark:border-emerald-500"
                        : keyStatus === "error" ? "border-red-400 dark:border-red-500"
                        : "border-surface-200 dark:border-surface-700"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300"
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={testApiKey}
                  disabled={!apiKey.trim() || testingKey}
                  className={clsx(
                    "px-3 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5",
                    "border border-surface-200 dark:border-surface-700",
                    "text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800",
                    "disabled:opacity-40 disabled:cursor-not-allowed"
                  )}
                >
                  {testingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : "Testar"}
                </button>
              </div>
              {keyStatus === "ok" && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="w-3.5 h-3.5" /> Chave válida!
                </p>
              )}
              {keyStatus === "error" && (
                <p className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
                  <AlertCircle className="w-3.5 h-3.5" /> {keyError}
                </p>
              )}
              {provider === "groq" && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Groq é usado para transcrição. Para resumos automáticos, adicione também uma chave OpenAI nas configurações.
                </p>
              )}
            </div>
          </div>
        );

      // ── Step 3: JGRC ──────────────────────────────────────────────────────
      case 3:
        return (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-1">
                Integração JGRC
              </h2>
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Conecte-se ao JGRC para exportar reuniões com um clique. Pode pular e configurar depois.
              </p>
            </div>
            {jgrcConnected ? (
              <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Conectado ao JGRC!</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-500">Sessão ativa</p>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleJgrcLogin}
                className="flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all bg-primary-500 hover:bg-primary-600 text-white shadow-sm"
              >
                <Link className="w-4 h-4" /> Entrar no JGRC
              </button>
            )}
            <p className="text-xs text-surface-400 dark:text-surface-500 text-center">
              Você pode conectar depois em <span className="font-medium">Configurações → Integração JGRC</span>.
            </p>
          </div>
        );

      // ── Step 4: Pronto ────────────────────────────────────────────────────
      case 4:
        return (
          <div className="flex flex-col items-center text-center gap-6 py-4">
            <div className="w-20 h-20 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-surface-900 dark:text-surface-100 mb-2">Tudo pronto!</h2>
              <p className="text-sm text-surface-500 dark:text-surface-400 max-w-xs leading-relaxed">
                O JGP Meeting está configurado. Clique em "Começar" para iniciar sua primeira gravação.
              </p>
            </div>
            <div className="w-full max-w-xs space-y-2">
              <ConfigItem label="Transcrição e Resumo" value={apiKey ? PROVIDER_LABELS[provider] : "Não configurado"} ok={!!apiKey} />
              <ConfigItem label="Integração JGRC" value={jgrcConnected ? "Conectado" : "Não configurado"} ok={jgrcConnected} optional />
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // ── Footer ─────────────────────────────────────────────────────────────────

  const isLastStep = step === TOTAL_STEPS - 1;
  // Steps 2 e 3 sempre avançam (pulável)
  const canSkip = step === 2 || step === 3;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className={clsx(
        "w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden",
        "bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700"
      )}>
        {/* Progress bar */}
        <div className="h-1 bg-surface-100 dark:bg-surface-800">
          <div
            className="h-full bg-primary-500 transition-all duration-500"
            style={{ width: `${((step + 1) / TOTAL_STEPS) * 100}%` }}
          />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <StepIndicator current={step} total={TOTAL_STEPS} />
          <span className="text-xs text-surface-400 dark:text-surface-500">{step + 1} / {TOTAL_STEPS}</span>
        </div>

        {/* Content */}
        <div className="px-6 py-4 min-h-[320px]">{renderStep()}</div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-surface-100 dark:border-surface-800 bg-surface-50/50 dark:bg-surface-800/30">
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 0}
            className={clsx(
              "flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-colors",
              "text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800",
              "disabled:opacity-0 disabled:pointer-events-none"
            )}
          >
            <ArrowLeft className="w-4 h-4" /> Voltar
          </button>

          <div className="flex items-center gap-3">
            {canSkip && (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="text-sm text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300 transition-colors"
              >
                Pular →
              </button>
            )}

            {isLastStep ? (
              <button
                type="button"
                onClick={handleComplete}
                disabled={saving}
                className="flex items-center gap-2 px-6 py-2 rounded-xl text-sm font-semibold bg-primary-500 hover:bg-primary-600 text-white shadow-sm transition-all disabled:opacity-60"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Começar a usar
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm font-semibold transition-all bg-primary-500 hover:bg-primary-600 text-white shadow-sm"
              >
                Próximo <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Helper ───────────────────────────────────────────────────────────────────

const ConfigItem: React.FC<{ label: string; value: string; ok: boolean; optional?: boolean }> = ({ label, value, ok, optional }) => (
  <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-50 dark:bg-surface-800/60">
    <span className="text-xs text-surface-500 dark:text-surface-400">{label}</span>
    <span className={clsx(
      "text-xs font-medium flex items-center gap-1",
      ok ? "text-emerald-600 dark:text-emerald-400"
        : optional ? "text-surface-400 dark:text-surface-500"
        : "text-amber-600 dark:text-amber-400"
    )}>
      {ok && <Check className="w-3 h-3" />}
      {value}
    </span>
  </div>
);
