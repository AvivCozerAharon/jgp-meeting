// components/TagManager.tsx
// Modal para gerenciamento global de tags (criar, renomear, deletar, escolher cor).

import React, { useState, useEffect, useCallback } from "react";
import clsx from "clsx";
import { X, Pencil, Trash2, Plus, Check } from "lucide-react";
import { getTags, saveTags } from "@/services/storageService";
import type { Tag } from "@/types";
import { TAG_COLORS } from "@/types";

// ─── Props ────────────────────────────────────────────────────────────────────

interface TagManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Inline form state ────────────────────────────────────────────────────────

interface FormState {
  mode: "create" | "edit";
  editingId?: string;
  name: string;
  color: string;
}

const defaultColor = TAG_COLORS[5]; // Azul

// ─── Component ────────────────────────────────────────────────────────────────

export const TagManager: React.FC<TagManagerProps> = ({ isOpen, onClose }) => {
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  // Load tags when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setIsLoading(true);
    setSaveError(null);
    getTags()
      .then(setTags)
      .catch((err) => {
        console.error("Failed to load tags:", err);
        setSaveError("Erro ao carregar tags.");
      })
      .finally(() => setIsLoading(false));
  }, [isOpen]);

  // Persist and update local state
  const persistTags = useCallback(async (updated: Tag[]) => {
    setSaveError(null);
    try {
      await saveTags(updated);
      setTags(updated);
    } catch (err) {
      console.error("Failed to save tags:", err);
      setSaveError("Erro ao salvar tags.");
    }
  }, []);

  // Delete handler
  const handleDelete = useCallback(
    (id: string) => {
      const updated = tags.filter((t) => t.id !== id);
      persistTags(updated);
      // If currently editing this tag, close form
      setForm((prev) =>
        prev?.mode === "edit" && prev.editingId === id ? null : prev
      );
    },
    [tags, persistTags]
  );

  // Start editing a tag
  const handleEditClick = useCallback((tag: Tag) => {
    setForm({ mode: "edit", editingId: tag.id, name: tag.name, color: tag.color });
  }, []);

  // Open create form
  const handleNewClick = useCallback(() => {
    setForm({ mode: "create", name: "", color: defaultColor });
  }, []);

  // Submit form (create or save edit)
  const handleFormSubmit = useCallback(async () => {
    if (!form) return;
    const trimmed = form.name.trim();
    if (!trimmed) return;

    let updated: Tag[];
    if (form.mode === "create") {
      const newTag: Tag = {
        id: crypto.randomUUID(),
        name: trimmed,
        color: form.color,
      };
      updated = [...tags, newTag];
    } else {
      updated = tags.map((t) =>
        t.id === form.editingId ? { ...t, name: trimmed, color: form.color } : t
      );
    }

    await persistTags(updated);
    setForm(null);
  }, [form, tags, persistTags]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        className={clsx(
          "w-full max-w-sm mx-4 rounded-2xl shadow-2xl overflow-hidden",
          "bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-100 dark:border-surface-800">
          <h2 className="text-base font-bold text-surface-900 dark:text-surface-100">
            Gerenciar Tags
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 dark:hover:text-surface-300 dark:hover:bg-surface-800 transition-colors"
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <p className="text-sm text-surface-500 dark:text-surface-400 text-center py-6">
              Carregando…
            </p>
          ) : tags.length === 0 && !form ? (
            <p className="text-sm text-surface-400 dark:text-surface-500 italic text-center py-6">
              Nenhuma tag criada ainda.
            </p>
          ) : (
            tags.map((tag) => (
              <div
                key={tag.id}
                className={clsx(
                  "flex items-center gap-3 px-3 py-2 rounded-xl",
                  "bg-surface-50 dark:bg-surface-800/60",
                  "border border-surface-100 dark:border-surface-700/50"
                )}
              >
                {/* Color dot */}
                <span
                  className="w-4 h-4 rounded-full flex-shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                {/* Name */}
                <span className="flex-1 text-sm text-surface-800 dark:text-surface-200 truncate">
                  {tag.name}
                </span>
                {/* Edit button */}
                <button
                  onClick={() => handleEditClick(tag)}
                  className="p-1 rounded-lg text-surface-400 hover:text-primary-500 hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors"
                  aria-label={`Editar tag ${tag.name}`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                {/* Delete button */}
                <button
                  onClick={() => handleDelete(tag.id)}
                  className="p-1 rounded-lg text-surface-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                  aria-label={`Deletar tag ${tag.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}

          {/* Inline create/edit form */}
          {form && (
            <div
              className={clsx(
                "mt-2 p-3 rounded-xl border space-y-3",
                "border-primary-300 dark:border-primary-600/50",
                "bg-primary-50/50 dark:bg-primary-900/10"
              )}
            >
              {/* Name input */}
              <input
                type="text"
                value={form.name}
                onChange={(e) =>
                  setForm((prev) => prev && { ...prev, name: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleFormSubmit();
                  if (e.key === "Escape") setForm(null);
                }}
                autoFocus
                placeholder="Nome da tag"
                className={clsx(
                  "w-full px-3 py-1.5 text-sm rounded-xl border",
                  "border-surface-200 dark:border-surface-700",
                  "bg-white dark:bg-surface-800/60",
                  "text-surface-800 dark:text-surface-200",
                  "placeholder:text-surface-400 dark:placeholder:text-surface-500",
                  "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
                  "transition-all"
                )}
              />

              {/* Color swatches */}
              <div className="flex flex-wrap gap-2">
                {TAG_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() =>
                      setForm((prev) => prev && { ...prev, color })
                    }
                    className={clsx(
                      "w-5 h-5 rounded-full flex items-center justify-center transition-all",
                      form.color === color
                        ? "ring-2 ring-offset-2 ring-primary-500 dark:ring-offset-surface-900 scale-110"
                        : "hover:scale-110"
                    )}
                    style={{ backgroundColor: color }}
                    aria-label={`Selecionar cor ${color}`}
                  >
                    {form.color === color && (
                      <Check className="w-3 h-3 text-white drop-shadow" />
                    )}
                  </button>
                ))}
              </div>

              {/* Form actions */}
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => setForm(null)}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleFormSubmit}
                  disabled={!form.name.trim()}
                  className={clsx(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold",
                    "bg-primary-500 text-white shadow-sm",
                    "hover:bg-primary-600 transition-all duration-150",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  <Check className="w-3.5 h-3.5" />
                  {form.mode === "create" ? "Criar" : "Salvar"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Error banner */}
        {saveError && (
          <div className="mx-5 mb-3 px-3 py-2 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
            <p className="text-xs text-red-700 dark:text-red-400">{saveError}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-surface-100 dark:border-surface-800 bg-surface-50/50 dark:bg-surface-800/30">
          <button
            onClick={handleNewClick}
            disabled={form?.mode === "create"}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium",
              "border border-surface-200 dark:border-surface-700",
              "text-surface-700 dark:text-surface-300",
              "hover:bg-surface-100 dark:hover:bg-surface-800 hover:border-primary-400 dark:hover:border-primary-500",
              "transition-all duration-150",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            <Plus className="w-4 h-4" />
            Nova tag
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-sm font-medium text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
