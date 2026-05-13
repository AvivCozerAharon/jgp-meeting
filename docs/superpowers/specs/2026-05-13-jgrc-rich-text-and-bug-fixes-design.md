# JGRC Rich Text Editor + Bug Fixes

**Date:** 2026-05-13
**Status:** Approved

## Overview

Two independent improvements to the JGRC export modal:
1. Replace the plain textarea for "Conteúdo" with a Tiptap rich text editor (HTML output)
2. Fix four bugs: `content` and `company` params ignored by backend, `event_url` never built/returned/persisted, `company_id` never sent

---

## Root Cause Analysis

### Bug 1 — Content ignored
`export_to_jgrc` in `commands.rs` accepts no `content` param. It always calls `build_jgrc_content(&meeting)` and ignores whatever the user edited in the modal. The frontend already sends `content: content || null` in the invoke call — the backend just drops it.

### Bug 2 — Company ID never sent
`export_to_jgrc` has no `company` param. The frontend sends `company: "jgp" | "regia"` but the backend drops it. `event[company_id]` is never added to the form.

### Bug 3 — Event URL never built
The backend returns `Ok(event_id)` as a plain `String`. The frontend invokes as `invoke<{ event_id: string; event_url: string }>` — this causes a deserialization error (or returns an unexpected value). The URL is never constructed and `meeting.jgrc_event_url` (which already exists in `Meeting`) is never populated.

### Bug 4 — Return type mismatch
Backend returns `Result<String, String>`, frontend expects `Result<{ event_id, event_url }, String>`.

---

## Feature 1 — Tiptap Rich Text Editor

### Library
Install: `@tiptap/react @tiptap/pm @tiptap/starter-kit @tiptap/extension-underline`

Extensions used: `StarterKit` (bold, italic, paragraph, lists, headings) + `Underline`.

Toolbar buttons: **B** (bold), *I* (italic), U (underline), unordered list, ordered list.

Output: `editor.getHTML()` — sent as the `content` field to the backend.

### UI Changes

Replace in `JgrcExportModal.tsx`:

```tsx
// OLD
<textarea
  value={content}
  onChange={(e) => setContent(e.target.value)}
  rows={5}
  className={clsx(inputClass, "resize-y leading-relaxed")}
  placeholder="Conteúdo do evento no JGRC..."
/>

// NEW — RichTextEditor component (inline in same file)
<RichTextEditor
  content={content}
  onChange={setContent}
/>
```

`content` state stays `string` (HTML). Initial value stays `meeting.summary?.summary ?? meeting.transcript.slice(0, 3000)`.

### RichTextEditor Component

Inline in `JgrcExportModal.tsx` (no new file):

```tsx
const RichTextEditor: React.FC<{ content: string; onChange: (html: string) => void }> = ({
  content,
  onChange,
}) => {
  const editor = useEditor({
    extensions: [StarterKit, Underline],
    content,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  if (!editor) return null;

  return (
    <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800/60 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-surface-100 dark:border-surface-700">
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive("bold")}
          title="Negrito"
        >
          <strong className="text-xs">B</strong>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive("italic")}
          title="Itálico"
        >
          <em className="text-xs">I</em>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive("underline")}
          title="Sublinhado"
        >
          <span className="text-xs underline">U</span>
        </ToolbarBtn>
        <div className="w-px h-4 bg-surface-200 dark:bg-surface-600 mx-1" />
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive("bulletList")}
          title="Lista"
        >
          <List className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive("orderedList")}
          title="Lista numerada"
        >
          <ListOrdered className="w-3.5 h-3.5" />
        </ToolbarBtn>
      </div>
      {/* Editor area */}
      <EditorContent
        editor={editor}
        className="px-3 py-2 text-sm text-surface-800 dark:text-surface-200 min-h-[120px] max-h-[200px] overflow-y-auto prose prose-sm dark:prose-invert max-w-none focus:outline-none"
      />
    </div>
  );
};

const ToolbarBtn: React.FC<{
  onClick: () => void;
  active: boolean;
  title: string;
  children: React.ReactNode;
}> = ({ onClick, active, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={clsx(
      "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
      active
        ? "bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300"
        : "text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700"
    )}
  >
    {children}
  </button>
);
```

Add to imports: `{ useEditor, EditorContent } from "@tiptap/react"`, `StarterKit from "@tiptap/starter-kit"`, `Underline from "@tiptap/extension-underline"`, `{ List, ListOrdered } from "lucide-react"`.

### Tiptap CSS

Add to `src/index.css` (or `App.tsx` global styles) the ProseMirror focus ring reset:

```css
.ProseMirror:focus {
  outline: none;
}
.ProseMirror ul {
  list-style-type: disc;
  padding-left: 1.25rem;
}
.ProseMirror ol {
  list-style-type: decimal;
  padding-left: 1.25rem;
}
```

---

## Feature 2 — Backend Bug Fixes

### Changes to `commands.rs`

**Add params to `export_to_jgrc`:**

```rust
pub async fn export_to_jgrc(
    meeting_id: String,
    event_type_id: Option<String>,
    responsible_id: Option<String>,
    subject: Option<String>,
    content: Option<String>,        // NEW — user-edited HTML
    actions: Option<String>,
    manager_id: Option<String>,
    attendees: Option<String>,
    internal_attendee_ids: Option<Vec<String>>,
    city_id: Option<String>,
    company: Option<String>,        // NEW — "jgp" | "regia"
) -> Result<JgrcExportResult, String> {
```

**Add return struct** (near other DTO structs, before the function):

```rust
#[derive(serde::Serialize)]
pub struct JgrcExportResult {
    pub event_id: String,
    pub event_url: String,
}
```

**Use `content` param instead of `build_jgrc_content`:**

```rust
// OLD
let content = build_jgrc_content(&meeting);

// NEW
let content = content
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| build_jgrc_content(&meeting));
```

**Add company_id to form:**

After the `city_id` block:

```rust
let company_id = match company.as_deref() {
    Some("regia") => "1",
    _ => "0",  // default JGP
};
form.push(("event[company_id]".into(), company_id.into()));
```

**Build event_url and return struct:**

```rust
// OLD
let mut meeting_mut = meeting;
meeting_mut.jgrc_event_id = Some(event_id.clone());
storage::save_meeting(&meeting_mut).map_err(|e| format!("Erro ao salvar: {e}"))?;
log::info!("Reunião '{}' exportada para JGRC (event_id={})", meeting_mut.title, event_id);
Ok(event_id)

// NEW
let event_url = format!("{base_url}/eventos/{event_id}");
let mut meeting_mut = meeting;
meeting_mut.jgrc_event_id = Some(event_id.clone());
meeting_mut.jgrc_event_url = Some(event_url.clone());
storage::save_meeting(&meeting_mut).map_err(|e| format!("Erro ao salvar: {e}"))?;
log::info!("Reunião '{}' exportada para JGRC (event_id={}, url={})", meeting_mut.title, event_id, event_url);
Ok(JgrcExportResult { event_id, event_url })
```

---

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-underline` |
| `src/components/JgrcExportModal.tsx` | Add `RichTextEditor` + `ToolbarBtn` inline components; replace textarea with `<RichTextEditor>`; add imports |
| `src/index.css` | Add ProseMirror focus/list styles |
| `src-tauri/src/commands.rs` | Add `content` + `company` params; add `JgrcExportResult` struct; use user content; add `company_id` to form; build + persist `event_url`; return `JgrcExportResult` |

---

## Out of Scope

- Heading levels (H1/H2) in toolbar — overkill for meeting notes
- Image upload in rich text editor
- Per-user default company preference in Settings (the modal toggle is sufficient)
