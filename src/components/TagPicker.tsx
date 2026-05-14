// components/TagPicker.tsx
// Inline dropdown to apply/remove tags, with inline tag management.

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Tag as TagIcon, Settings2 } from "lucide-react";
import clsx from "clsx";
import { updateMeetingTags } from "../services/storageService";
import { TagManager } from "./TagManager";
import type { Tag } from "../types";

interface TagPickerProps {
  meetingId: string;
  currentTagIds: string[];
  allTags: Tag[];
  onTagsChange: (newTagIds: string[]) => void;
  onTagsUpdated?: (tags: Tag[]) => void;
}

export const TagPicker: React.FC<TagPickerProps> = ({
  meetingId,
  currentTagIds,
  allTags,
  onTagsChange,
  onTagsUpdated,
}) => {
  const [open, setOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>(currentTagIds);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setTagIds(currentTagIds); }, [currentTagIds]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleToggle = useCallback(async (tagId: string) => {
    const prev = tagIds;
    const next = prev.includes(tagId)
      ? prev.filter((id) => id !== tagId)
      : [...prev, tagId];
    setTagIds(next);
    try {
      await updateMeetingTags(meetingId, next);
      onTagsChange(next);
    } catch {
      setTagIds(prev);
    }
  }, [meetingId, tagIds, onTagsChange]);

  const handleOpenManager = () => {
    setOpen(false);
    setTagManagerOpen(true);
  };

  const appliedTags = allTags.filter((t) => tagIds.includes(t.id));

  return (
    <div ref={containerRef} className="relative inline-block">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150",
          open
            ? "bg-surface-100 dark:bg-surface-700 border-surface-300 dark:border-surface-600 text-surface-700 dark:text-surface-200"
            : "bg-transparent border-surface-200 dark:border-surface-700 text-surface-500 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-800/60 hover:text-surface-700 dark:hover:text-surface-200"
        )}
      >
        <TagIcon className="w-3.5 h-3.5" />
        Tags
        {tagIds.length > 0 && (
          <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300 text-[10px] font-semibold leading-none">
            {tagIds.length}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className={clsx(
          "absolute left-0 top-full mt-1.5 z-50 w-[220px] rounded-xl shadow-lg border py-2",
          "bg-white dark:bg-surface-800 border-surface-200 dark:border-surface-700"
        )}>
          {/* Applied chips */}
          {appliedTags.length > 0 && (
            <div className="px-3 pb-2 flex flex-wrap gap-1 border-b border-surface-100 dark:border-surface-700/60 mb-1">
              {appliedTags.map((tag) => (
                <span key={tag.id} className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-surface-100 dark:bg-surface-700/60 text-surface-700 dark:text-surface-300">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </span>
              ))}
            </div>
          )}

          {/* Tag list */}
          {allTags.length === 0 ? (
            <p className="px-3 py-2 text-xs text-surface-400 dark:text-surface-500 italic">
              Nenhuma tag. Crie uma abaixo.
            </p>
          ) : (
            <ul className="max-h-44 overflow-y-auto">
              {allTags.map((tag) => {
                const checked = tagIds.includes(tag.id);
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      onClick={() => handleToggle(tag.id)}
                      className={clsx(
                        "w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors duration-100",
                        "hover:bg-surface-50 dark:hover:bg-surface-700/50",
                        checked ? "text-surface-800 dark:text-surface-100" : "text-surface-600 dark:text-surface-400"
                      )}
                    >
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                      <span className="flex-1 truncate">{tag.name}</span>
                      {checked && <span className="text-primary-500 dark:text-primary-400 font-bold text-[10px]">✓</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Gerenciar */}
          <div className="border-t border-surface-100 dark:border-surface-700/60 mt-1 pt-1 px-2">
            <button
              type="button"
              onClick={handleOpenManager}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-50 dark:hover:bg-surface-700/50 transition-colors"
            >
              <Settings2 className="w-3.5 h-3.5" />
              Gerenciar tags...
            </button>
          </div>
        </div>
      )}

      {/* TagManager inline */}
      <TagManager
        isOpen={tagManagerOpen}
        onClose={(updatedTags) => {
          setTagManagerOpen(false);
          if (updatedTags) onTagsUpdated?.(updatedTags);
        }}
      />
    </div>
  );
};
