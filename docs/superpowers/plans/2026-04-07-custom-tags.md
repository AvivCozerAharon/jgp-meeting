# Custom Tags (Trello-style) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to create global named+colored tags and apply them to meetings, with filtering in the history page.

**Architecture:** New `Tag` struct + `tags.json` in Rust storage. Three new Tauri commands. Frontend: `TagManager` modal, `TagPicker` inline in MeetingDetail, tag chips in `MeetingCard`, filter bar in `HistoryPage`.

**Tech Stack:** Rust (storage, commands), TypeScript/React (types, services, components, pages)

---

## File Map

| File | Change |
|---|---|
| `src-tauri/src/storage/mod.rs` | Add `Tag` struct, `Meeting.tags`, `load_tags`, `save_tags`, `tags_file_path` |
| `src-tauri/src/commands.rs` | Add `get_tags`, `save_tags`, `update_meeting_tags` commands |
| `src-tauri/src/main.rs` | Register 3 new commands in invoke_handler |
| `src/types/index.ts` | Add `Tag` interface, `Meeting.tags` field |
| `src/services/storageService.ts` | Add `getTags`, `saveTags`, `updateMeetingTags` |
| `src/components/TagManager.tsx` | **New** — create/edit/delete tags modal |
| `src/components/TagPicker.tsx` | **New** — apply/remove tags on a meeting |
| `src/components/MeetingCard.tsx` | Show tag chips |
| `src/pages/HistoryPage.tsx` | Tag filter bar + pass tags to MeetingCard + TagPicker in detail view |
| `src/components/SettingsModal.tsx` | "Gerenciar Tags" button that opens TagManager |

---

## Task 1: Rust — `Tag` struct, `Meeting.tags`, storage functions

**Files:**
- Modify: `src-tauri/src/storage/mod.rs`

- [ ] **Step 1: Add `Tag` struct**

In `src-tauri/src/storage/mod.rs`, after the `MeetingType` impl block (after line ~49), add:

```rust
// ─── Tag ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// One of the 10 fixed hex color values from the frontend palette
    pub color: String,
}
```

- [ ] **Step 2: Add `tags` field to `Meeting` struct**

In the `Meeting` struct, after the `jgrc_event_id` field, add:

```rust
/// Tags aplicadas à reunião (lista de IDs de Tag)
#[serde(default)]
pub tags: Vec<String>,
```

In `Meeting::new()`, add `tags: Vec::new(),` to the struct initializer.

- [ ] **Step 3: Add storage functions for tags**

After the `settings_file_path()` function, add:

```rust
fn tags_file_path() -> Result<PathBuf> {
    Ok(app_data_dir()?.join("tags.json"))
}

pub fn load_tags() -> Result<Vec<Tag>> {
    let path = tags_file_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let json = fs::read_to_string(&path).context("Falha ao ler tags")?;
    serde_json::from_str(&json).context("Falha ao parsear tags")
}

pub fn save_tags(tags: &[Tag]) -> Result<()> {
    let path = tags_file_path()?;
    let json = serde_json::to_string_pretty(tags).context("Falha ao serializar tags")?;
    fs::write(&path, json).context("Falha ao salvar tags")?;
    log::info!("Tags salvas ({} tags)", tags.len());
    Ok(())
}
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/mod.rs
git commit -m "feat(storage): add Tag struct, Meeting.tags field, and tags persistence functions"
```

---

## Task 2: Rust — tag commands + registration

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the three tag commands to `commands.rs`**

At the end of `src-tauri/src/commands.rs` (before the last closing brace, or after the last command), add:

```rust
// ─── Tags ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_tags() -> Result<Vec<storage::Tag>, String> {
    storage::load_tags().map_err(|e| format!("Erro ao carregar tags: {e}"))
}

#[tauri::command]
pub async fn save_tags(tags: Vec<storage::Tag>) -> Result<(), String> {
    storage::save_tags(&tags).map_err(|e| format!("Erro ao salvar tags: {e}"))
}

#[tauri::command]
pub async fn update_meeting_tags(
    meeting_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let mut meeting = storage::load_meeting(&meeting_id)
        .map_err(|e| format!("Reunião não encontrada: {e}"))?;
    meeting.tags = tag_ids;
    storage::save_meeting(&meeting).map_err(|e| format!("Erro ao salvar reunião: {e}"))
}
```

- [ ] **Step 2: Register commands in `main.rs`**

In `src-tauri/src/main.rs`, inside `tauri::generate_handler![...]`, after `commands::jgrc_get_export_data,` add:

```rust
// Tags
commands::get_tags,
commands::save_tags,
commands::update_meeting_tags,
```

- [ ] **Step 3: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(commands): add get_tags, save_tags, update_meeting_tags commands"
```

---

## Task 3: TypeScript types + service functions

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/storageService.ts`

- [ ] **Step 1: Add `Tag` interface and `Meeting.tags` to `types/index.ts`**

After the `SpeakerSegment` interface (around line 38), add:

```ts
// ─── Tags ─────────────────────────────────────────────────────────────────────

export interface Tag {
  id: string;
  name: string;
  /** One of the 10 fixed hex values from TAG_COLORS */
  color: string;
}

/** 10 fixed colors for tags (Trello-inspired) */
export const TAG_COLORS: { label: string; hex: string }[] = [
  { label: "Vermelho",  hex: "#ef4444" },
  { label: "Laranja",   hex: "#f97316" },
  { label: "Amarelo",   hex: "#eab308" },
  { label: "Verde",     hex: "#22c55e" },
  { label: "Turquesa",  hex: "#14b8a6" },
  { label: "Azul",      hex: "#3b82f6" },
  { label: "Índigo",    hex: "#6366f1" },
  { label: "Roxo",      hex: "#a855f7" },
  { label: "Rosa",      hex: "#ec4899" },
  { label: "Cinza",     hex: "#6b7280" },
];
```

In the `Meeting` interface, after `jgrc_event_id`, add:

```ts
/** IDs das tags aplicadas à reunião */
tags?: string[];
```

- [ ] **Step 2: Add service functions to `storageService.ts`**

At the end of `src/services/storageService.ts`, add:

```ts
export async function getTags(): Promise<Tag[]> {
  return await invoke<Tag[]>("get_tags");
}

export async function saveTags(tags: Tag[]): Promise<void> {
  await invoke("save_tags", { tags });
}

export async function updateMeetingTags(meetingId: string, tagIds: string[]): Promise<void> {
  await invoke("update_meeting_tags", { meeting_id: meetingId, tag_ids: tagIds });
}
```

Add `Tag` to the import from `@/types` at the top of `storageService.ts`.

- [ ] **Step 3: Check TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/services/storageService.ts
git commit -m "feat(types): add Tag interface, Meeting.tags, TAG_COLORS, and tag service functions"
```

---

## Task 4: `TagManager` component

**Files:**
- Create: `src/components/TagManager.tsx`

- [ ] **Step 1: Create `TagManager.tsx`**

Create `src/components/TagManager.tsx`:

```tsx
// components/TagManager.tsx
// Modal para criar, renomear, recolorir e deletar tags globais.

import React, { useState, useEffect, useCallback } from "react";
import clsx from "clsx";
import { X, Plus, Trash2, Check } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { Tag } from "@/types";
import { TAG_COLORS } from "@/types";
import { getTags, saveTags } from "@/services/storageService";

interface TagManagerProps {
  onClose: () => void;
}

export const TagManager: React.FC<TagManagerProps> = ({ onClose }) => {
  const [tags, setTags] = useState<Tag[]>([]);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TAG_COLORS[5].hex); // azul por padrão
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTags().then(setTags).catch(() => setTags([]));
  }, []);

  const persist = useCallback(async (updated: Tag[]) => {
    setSaving(true);
    try {
      await saveTags(updated);
      setTags(updated);
    } catch {
      setError("Erro ao salvar tags.");
    } finally {
      setSaving(false);
    }
  }, []);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setError("Já existe uma tag com esse nome.");
      return;
    }
    setError(null);
    const tag: Tag = { id: uuidv4(), name, color: newColor };
    await persist([...tags, tag]);
    setNewName("");
  };

  const handleDelete = async (id: string) => {
    await persist(tags.filter((t) => t.id !== id));
  };

  const handleColorChange = async (id: string, color: string) => {
    await persist(tags.map((t) => (t.id === id ? { ...t, color } : t)));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-700 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-100 dark:border-surface-800 flex-shrink-0">
          <h2 className="text-base font-bold text-surface-900 dark:text-surface-100">Gerenciar Tags</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tag list */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {tags.length === 0 && (
            <p className="text-sm text-surface-400 dark:text-surface-500 text-center py-6">
              Nenhuma tag criada ainda.
            </p>
          )}
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="flex items-center gap-3 px-3 py-2 rounded-xl bg-surface-50 dark:bg-surface-800/60 border border-surface-100 dark:border-surface-700/50"
            >
              {/* Color swatches inline */}
              <div className="flex items-center gap-1 flex-wrap w-32 flex-shrink-0">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    onClick={() => handleColorChange(tag.id, c.hex)}
                    title={c.label}
                    style={{ background: c.hex }}
                    className="w-4 h-4 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                  >
                    {tag.color === c.hex && (
                      <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                    )}
                  </button>
                ))}
              </div>

              {/* Tag name */}
              <span
                className="flex-1 text-sm font-medium truncate"
                style={{ color: tag.color }}
              >
                {tag.name}
              </span>

              {/* Delete */}
              <button
                onClick={() => handleDelete(tag.id)}
                className="p-1 rounded-lg text-surface-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Add new tag */}
        <div className="border-t border-surface-100 dark:border-surface-800 p-4 flex-shrink-0">
          {error && (
            <p className="text-xs text-red-500 mb-2">{error}</p>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="Nome da tag..."
              className="flex-1 px-3 py-2 text-sm rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/60 text-surface-800 dark:text-surface-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            {/* Color picker */}
            <div className="flex gap-1">
              {TAG_COLORS.map((c) => (
                <button
                  key={c.hex}
                  onClick={() => setNewColor(c.hex)}
                  title={c.label}
                  style={{ background: c.hex }}
                  className="w-5 h-5 rounded-full flex items-center justify-center transition-transform hover:scale-110 flex-shrink-0"
                >
                  {newColor === c.hex && (
                    <Check className="w-3 h-3 text-white" strokeWidth={3} />
                  )}
                </button>
              ))}
            </div>
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || saving}
              className="flex items-center gap-1 px-3 py-2 rounded-xl text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Criar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Check TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep TagManager
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/TagManager.tsx
git commit -m "feat(ui): add TagManager modal component for creating and deleting tags"
```

---

## Task 5: `TagPicker` component + `MeetingCard` tag chips

**Files:**
- Create: `src/components/TagPicker.tsx`
- Modify: `src/components/MeetingCard.tsx`

- [ ] **Step 1: Create `TagPicker.tsx`**

Create `src/components/TagPicker.tsx`:

```tsx
// components/TagPicker.tsx
// Dropdown inline para aplicar/remover tags em uma reunião.

import React, { useState, useEffect, useRef } from "react";
import clsx from "clsx";
import { Tag as TagIcon, Check } from "lucide-react";
import type { Tag } from "@/types";
import { getTags, updateMeetingTags } from "@/services/storageService";

interface TagPickerProps {
  meetingId: string;
  /** IDs das tags atualmente aplicadas à reunião */
  appliedTagIds: string[];
  /** Chamado após atualização bem-sucedida com a nova lista de IDs */
  onChange: (tagIds: string[]) => void;
}

export const TagPicker: React.FC<TagPickerProps> = ({ meetingId, appliedTagIds, onChange }) => {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getTags().then(setAllTags).catch(() => setAllTags([]));
  }, []);

  // Fecha ao clicar fora
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = async (tagId: string) => {
    const next = appliedTagIds.includes(tagId)
      ? appliedTagIds.filter((id) => id !== tagId)
      : [...appliedTagIds, tagId];
    try {
      await updateMeetingTags(meetingId, next);
      onChange(next);
      setError(null);
    } catch {
      setError("Erro ao atualizar tags.");
    }
  };

  const appliedTags = allTags.filter((t) => appliedTagIds.includes(t.id));

  return (
    <div ref={ref} className="relative">
      {/* Applied tag chips + trigger button */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {appliedTags.map((tag) => (
          <span
            key={tag.id}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-white"
            style={{ background: tag.color }}
          >
            {tag.name}
          </span>
        ))}
        <button
          onClick={() => setOpen((o) => !o)}
          className={clsx(
            "flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors",
            "border border-dashed border-surface-300 dark:border-surface-600",
            "text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300",
            "hover:border-surface-400 dark:hover:border-surface-500"
          )}
        >
          <TagIcon className="w-3 h-3" />
          {appliedTags.length === 0 ? "Tags" : "+"}
        </button>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-48 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl shadow-lg overflow-hidden">
          {error && <p className="text-xs text-red-500 px-3 py-1">{error}</p>}
          {allTags.length === 0 ? (
            <p className="text-xs text-surface-400 px-3 py-3 text-center">
              Nenhuma tag criada.<br />Crie em Configurações → Gerenciar Tags.
            </p>
          ) : (
            allTags.map((tag) => {
              const active = appliedTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggle(tag.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
                >
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0 flex items-center justify-center"
                    style={{ background: tag.color }}
                  >
                    {active && <Check className="w-2 h-2 text-white" strokeWidth={3} />}
                  </span>
                  <span className={clsx(
                    "flex-1 text-left",
                    active
                      ? "text-surface-800 dark:text-surface-200 font-medium"
                      : "text-surface-600 dark:text-surface-400"
                  )}>
                    {tag.name}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Add tag chips to `MeetingCard`**

In `src/components/MeetingCard.tsx`:

Add `Tag` to the import from `@/types`:
```ts
import type { Meeting, Tag } from "@/types";
```

Update `MeetingCardProps` to accept tags:
```ts
interface MeetingCardProps {
  meeting: Meeting;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onGenerateSummary?: (id: string) => void;
  isGeneratingSummary?: boolean;
  className?: string;
  allTags?: Tag[];
}
```

Update the component destructuring:
```ts
export const MeetingCard: React.FC<MeetingCardProps> = ({
  meeting,
  onOpen,
  onDelete,
  onGenerateSummary,
  isGeneratingSummary = false,
  className,
  allTags = [],
}) => {
```

In the render, after the title/summary/JGRC badges row and before the `{preview &&` block, add tag chips:

```tsx
{/* Tag chips */}
{(meeting.tags ?? []).length > 0 && (
  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
    {(meeting.tags ?? []).map((tagId) => {
      const tag = allTags.find((t) => t.id === tagId);
      if (!tag) return null;
      return (
        <span
          key={tagId}
          className="px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white"
          style={{ background: tag.color }}
        >
          {tag.name}
        </span>
      );
    })}
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/TagPicker.tsx src/components/MeetingCard.tsx
git commit -m "feat(ui): add TagPicker component and tag chips to MeetingCard"
```

---

## Task 6: Tag filter bar in `HistoryPage` + TagPicker in detail + SettingsModal button

**Files:**
- Modify: `src/pages/HistoryPage.tsx`
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Add tag state + filter logic to `HistoryPage`**

In `src/pages/HistoryPage.tsx`, add these imports:

```ts
import type { Tag } from "@/types";
import { getTags } from "@/services/storageService";
import { TagPicker } from "@/components/TagPicker";
import { TagManager } from "@/components/TagManager";
```

Inside the `HistoryPage` component, add state:

```ts
const [allTags, setAllTags] = useState<Tag[]>([]);
const [activeTagId, setActiveTagId] = useState<string | null>(null);
```

Add a `useEffect` to load tags:

```ts
useEffect(() => {
  getTags().then(setAllTags).catch(() => {});
}, []);
```

Filter meetings by active tag (after the existing `meetings` from state):

```ts
const filteredMeetings = activeTagId
  ? meetings.filter((m) => (m.tags ?? []).includes(activeTagId))
  : meetings;
```

- [ ] **Step 2: Add tag filter bar to the list view**

In the `HistoryPage` JSX, between the search bar and the error/content section (after the closing `</div>` of the search bar wrapper, before `{/* Erro */}`), add:

```tsx
{/* Filtro por tag */}
{allTags.length > 0 && (
  <div className="px-6 pt-3 flex items-center gap-2 flex-wrap flex-shrink-0">
    <button
      onClick={() => setActiveTagId(null)}
      className={clsx(
        "px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
        activeTagId === null
          ? "bg-primary-500 text-white border-primary-500"
          : "border-surface-200 dark:border-surface-700 text-surface-500 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-600"
      )}
    >
      Todas
    </button>
    {allTags.map((tag) => (
      <button
        key={tag.id}
        onClick={() => setActiveTagId(activeTagId === tag.id ? null : tag.id)}
        className={clsx(
          "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
          activeTagId === tag.id
            ? "text-white border-transparent"
            : "border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-600"
        )}
        style={activeTagId === tag.id ? { background: tag.color, borderColor: tag.color } : {}}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: tag.color }}
        />
        {tag.name}
      </button>
    ))}
  </div>
)}
```

Replace `meetings.map(...)` with `filteredMeetings.map(...)` and pass `allTags` to each `MeetingCard`:

```tsx
{filteredMeetings.map((meeting) => (
  <MeetingCard
    key={meeting.id}
    meeting={meeting}
    onOpen={actions.selectMeeting}
    onDelete={actions.remove}
    onGenerateSummary={actions.generateSummary}
    isGeneratingSummary={isGeneratingSummary}
    allTags={allTags}
  />
))}
```

- [ ] **Step 3: Add `TagPicker` to `MeetingDetailView`**

In the `MeetingDetailView` component (lower in `HistoryPage.tsx`), add `allTags` prop:

```ts
interface MeetingDetailViewProps {
  meeting: Meeting;
  onBack: () => void;
  onGenerateSummary: (id: string) => Promise<void>;
  isGeneratingSummary: boolean;
  error: string | null;
  onClearError: () => void;
  onUpdateMeta: (id: string, title?: string, transcript?: string) => Promise<void>;
  onExportToJgrc: (meetingId: string) => Promise<string>;
  allTags: Tag[];
  onTagsChange: (meetingId: string, tagIds: string[]) => void;
}
```

Pass `allTags` and `onTagsChange` from `HistoryPage` when rendering `MeetingDetailView`:

```tsx
<MeetingDetailView
  meeting={selectedMeeting}
  onBack={actions.closeMeeting}
  onGenerateSummary={actions.generateSummary}
  isGeneratingSummary={isGeneratingSummary}
  error={error}
  onClearError={actions.clearError}
  onUpdateMeta={actions.updateMeta}
  onExportToJgrc={actions.exportToJgrc}
  allTags={allTags}
  onTagsChange={(id, tagIds) => {
    actions.refresh();
    setAllTags((prev) => prev); // tags unchanged, just refresh meetings
  }}
/>
```

Inside `MeetingDetailView`, destructure `allTags` and `onTagsChange`. Find a suitable place in the detail header (below the title/date/type info, before the tab bar), and add:

```tsx
<div className="px-6 pb-3">
  <TagPicker
    meetingId={meeting.id}
    appliedTagIds={meeting.tags ?? []}
    onChange={(tagIds) => onTagsChange(meeting.id, tagIds)}
  />
</div>
```

- [ ] **Step 4: Add "Gerenciar Tags" button to `SettingsModal`**

In `src/components/SettingsModal.tsx`, add `TagManager` import:

```ts
import { TagManager } from "./TagManager";
```

Add state:
```ts
const [showTagManager, setShowTagManager] = useState(false);
```

Find a suitable section in the SettingsModal (e.g., after the theme section, or in a "Organização" section). Add a button:

```tsx
<SettingRow
  title="Tags"
  description="Crie e gerencie tags personalizadas para organizar suas reuniões."
>
  <button
    onClick={() => setShowTagManager(true)}
    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors border border-surface-200 dark:border-surface-700"
  >
    Gerenciar Tags
  </button>
</SettingRow>

{showTagManager && <TagManager onClose={() => setShowTagManager(false)} />}
```

- [ ] **Step 5: Verify TypeScript and do a manual end-to-end test**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

Manual test:
1. Open Settings → click "Gerenciar Tags" → create tag "Importante" (vermelho) → close
2. Go to History → click a meeting → TagPicker shows → apply "Importante" → back
3. Meeting card shows red "Importante" chip
4. In History header, "Importante" chip appears → click it → only tagged meetings shown

- [ ] **Step 6: Commit**

```bash
git add src/pages/HistoryPage.tsx src/components/SettingsModal.tsx
git commit -m "feat(ui): add tag filter bar, TagPicker in detail view, and Gerenciar Tags button"
```
