// components/TranscriptQA.tsx
// Feature 29: Componente de perguntas e respostas sobre a transcrição da reunião.

import React, { useState, useRef, useEffect } from "react";
import clsx from "clsx";
import { MessageCircle, Send, AlertCircle, User, Bot } from "lucide-react";
import { askAboutTranscript } from "@/services/aiSummaryService";
import { Spinner } from "./LoadingSpinner";

interface QAPair {
  question: string;
  answer: string;
  id: number;
}

interface TranscriptQAProps {
  meetingId: string;
  apiKey: string;
  model?: string;
  hasTranscript: boolean;
}

export const TranscriptQA: React.FC<TranscriptQAProps> = ({
  meetingId,
  apiKey,
  model,
  hasTranscript,
}) => {
  const [pairs, setPairs] = useState<QAPair[]>([]);
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(0);

  // Scroll para o fim ao adicionar novas respostas
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [pairs]);

  const handleAsk = async () => {
    const q = question.trim();
    if (!q || isLoading) return;

    if (!apiKey) {
      setError("Configure a chave da API OpenAI nas Configurações.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setQuestion("");

    try {
      const answer = await askAboutTranscript(meetingId, q, apiKey, model);
      setPairs((prev) => [
        ...prev,
        { question: q, answer, id: idRef.current++ },
      ]);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
      // Foca o input novamente
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  if (!hasTranscript) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-8">
        <MessageCircle className="w-8 h-8 text-surface-300 dark:text-surface-600" />
        <p className="text-sm text-surface-400 dark:text-surface-500">
          Esta reunião não possui transcrição para consultar.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Lista de Q&A */}
      <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
        {pairs.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
            <MessageCircle className="w-8 h-8 text-surface-300 dark:text-surface-600" />
            <p className="text-xs text-surface-400 dark:text-surface-500 leading-relaxed">
              Faça uma pergunta sobre o conteúdo desta reunião.
              <br />
              Ex: "Quais foram as decisões tomadas?"
            </p>
          </div>
        )}

        {pairs.map((pair) => (
          <div key={pair.id} className="space-y-2">
            {/* Pergunta */}
            <div className="flex items-start gap-2 justify-end">
              <div className="max-w-[85%] bg-primary-500 text-white text-xs rounded-2xl rounded-tr-sm px-3 py-2 leading-relaxed">
                {pair.question}
              </div>
              <div className="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                <User className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400" />
              </div>
            </div>

            {/* Resposta */}
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-surface-100 dark:bg-surface-700 flex items-center justify-center flex-shrink-0">
                <Bot className="w-3.5 h-3.5 text-surface-500 dark:text-surface-400" />
              </div>
              <div className="max-w-[85%] bg-surface-50 dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700 text-surface-700 dark:text-surface-200 text-xs rounded-2xl rounded-tl-sm px-3 py-2 leading-relaxed whitespace-pre-wrap">
                {pair.answer}
              </div>
            </div>
          </div>
        ))}

        {/* Indicador de carregamento */}
        {isLoading && (
          <div className="flex items-start gap-2">
            <div className="w-6 h-6 rounded-full bg-surface-100 flex items-center justify-center flex-shrink-0">
              <Bot className="w-3.5 h-3.5 text-surface-500" />
            </div>
            <div className="bg-surface-50 dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700 rounded-2xl rounded-tl-sm px-3 py-2">
              <Spinner size="xs" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Erro */}
      {error && (
        <div className="flex items-start gap-1.5 p-2 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl flex-shrink-0">
          <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Input */}
      <div className="flex gap-2 flex-shrink-0">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Faça uma pergunta... (Enter para enviar)"
          disabled={isLoading}
          rows={2}
          className={clsx(
            "flex-1 px-3 py-2 text-xs rounded-xl border resize-none",
            "border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
            "placeholder:text-surface-300 dark:placeholder:text-surface-600 transition-all",
            "disabled:opacity-60"
          )}
        />
        <button
          onClick={handleAsk}
          disabled={!question.trim() || isLoading}
          className={clsx(
            "flex items-center justify-center w-9 h-9 mt-0.5 rounded-xl",
            "bg-primary-500 text-white shadow-sm",
            "hover:bg-primary-600 transition-all duration-150",
            "focus:outline-none focus:ring-2 focus:ring-primary-500",
            "disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          )}
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
