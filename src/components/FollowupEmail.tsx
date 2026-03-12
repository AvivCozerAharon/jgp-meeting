// components/FollowupEmail.tsx — Feature 9
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  meetingId: string;
  apiKey: string;
  model?: string;
  existingEmail?: string | null;
  onGenerated: (email: string) => void;
}

export function FollowupEmail({ meetingId, apiKey, model, existingEmail, onGenerated }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const email = await invoke<string>('generate_followup_email', {
        meetingId,
        apiKey,
        model: model ?? null,
      });
      onGenerated(email);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async () => {
    if (!existingEmail) return;
    await navigator.clipboard.writeText(existingEmail);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 flex items-center gap-2">
          <span>📧</span> E-mail de Follow-up
        </h3>
        <div className="flex items-center gap-2">
          {existingEmail && (
            <button
              onClick={copyToClipboard}
              className="text-xs px-2.5 py-1 bg-surface-200 hover:bg-surface-300 text-surface-700 dark:bg-surface-700 dark:hover:bg-surface-600 dark:text-surface-300 rounded transition-colors"
            >
              {copied ? '✓ Copiado!' : 'Copiar'}
            </button>
          )}
          <button
            onClick={generate}
            disabled={loading || !apiKey}
            className={[
              'text-xs px-3 py-1.5 rounded font-medium transition-all',
              existingEmail
                ? 'bg-surface-200 hover:bg-surface-300 text-surface-700 dark:bg-surface-700 dark:hover:bg-surface-600 dark:text-surface-300'
                : 'bg-blue-600 hover:bg-blue-700 text-white',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            {loading ? (
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                Gerando...
              </span>
            ) : existingEmail ? (
              'Regenerar'
            ) : (
              'Gerar E-mail'
            )}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-900/20 dark:border-red-900/40 rounded px-3 py-2">
          {error}
        </p>
      )}

      {existingEmail ? (
        <pre className="whitespace-pre-wrap font-sans text-xs text-surface-700 bg-surface-50 border border-surface-100 dark:text-surface-300 dark:bg-surface-800/60 dark:border-surface-700 rounded-lg p-4 max-h-72 overflow-y-auto leading-relaxed">
          {existingEmail}
        </pre>
      ) : (
        !loading && (
          <p className="text-xs text-surface-500 dark:text-surface-500 italic">
            Gere um rascunho profissional de e-mail com o resumo e as tarefas da reunião.
          </p>
        )
      )}
    </div>
  );
}
