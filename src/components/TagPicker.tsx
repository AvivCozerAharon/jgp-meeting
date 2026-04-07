// components/TagPicker.tsx
// Inline dropdown/popover to apply or remove tags on a meeting.

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Tag as TagIcon } from "lucide-react";
import clsx from "clsx";
import { updateMeetingTags } from "../services/storageService";
import type { Tag } from "../types";

interface TagPickerProps {
  meetingId: string;
  currentTagIds: string[];
  allTags: Tag[];
  onTagsChange: (newTagIds: string[]) => void;
}

export const TagPicker: React.FC<TagPickerProps> = ({
  meetingId,
  currentTagIds,
  allTags,
  onTagsChange,
}) => {
  const [open, setOpen] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>(currentTagIds);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync with parent if currentTagIds changes externally
  useEffect(() => {
    setTagIds(currentTagIds);
  }, [currentTagIds]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleToggle = useCallback(
    async (tagId: string) => {
      const prev = tagIds;
      const next = prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId];

      // Optimistic update
      setTagIds(next);

      try {
        await updateMeetingTags(meetingId, next);
        onTagsChange(next);
      } catch (err) {
        console.error("Failed to update meeting tags:", err);
        // Revert
        setTagIds(prev);
      }
    },
    [meetingId, tagIds, onTagsChange]
  );

  const appliedTags = allTags.filter((t) => tagIds.includes(t.id));

  return (
    <div ref={containerRef} className="relative inline-block">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium",
          "border transition-all duration-150",
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
        <div
          className={clsx(
            "absolute left-0 top-full mt-1.5 z-50 w-[220px]",
            "rounded-xl shadow-lg border",
            "bg-white dark:bg-surface-800",
            "border-surface-200 dark:border-surface-700",
            "py-2"
          )}
        >
          {/* Applied chips */}
          {appliedTags.length > 0 && (
            <div className="px-3 pb-2 flex flex-wrap gap-1 border-b border-surface-100 dark:border-surface-700/60 mb-1">
              {appliedTags.map((tag) => (
                <span
                  key={tag.id}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-surface-100 dark:bg-surface-700/60 text-surface-700 dark:text-surface-300"
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </span>
              ))}
            </div>
          )}

          {/* Tag list */}
          {allTags.length === 0 ? (
            <p className="px-3 py-2 text-xs text-surface-400 dark:text-surface-500">
              Nenhuma tag criada.
            </p>
          ) : (
            <ul className="max-h-48 overflow-y-auto">
              {allTags.map((tag) => {
                const checked = tagIds.includes(tag.id);
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      onClick={() => handleToggle(tag.id)}
                      className={clsx(
                        "w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs",
                        "transition-colors duration-100",
                        "hover:bg-surface-50 dark:hover:bg-surface-700/50",
                        checked
                          ? "text-surface-800 dark:text-surface-100"
                          : "text-surface-600 dark:text-surface-400"
                      )}
                    >
                      {/* Color dot */}
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: tag.color }}
                      />
                      {/* Tag name */}
                      <span className="flex-1 truncate">{tag.name}</span>
                      {/* Checkmark */}
                      {checked && (
                        <span className="text-primary-500 dark:text-primary-400 font-bold text-[10px]">
                          ✓
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
