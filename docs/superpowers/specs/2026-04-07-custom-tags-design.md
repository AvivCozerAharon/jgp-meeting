# Design: Custom Tags (Trello-style) for Meetings

**Date:** 2026-04-07
**Status:** Approved

## Problem

Meetings accumulate in the history with no way to categorize or organize them beyond meeting type and date. Users need a lightweight labeling system to group meetings by project, client, topic, or urgency.

## Goal

Allow users to create named, colored tags and apply them to meetings. The history page can be filtered by tag.

## Scope

**In scope:**
- `Tag { id, name, color }` struct + `tags.json` storage
- CRUD commands: `get_tags`, `save_tags`
- `update_meeting_tags(meeting_id, tag_ids)` command
- `Meeting.tags: Vec<String>` field (tag IDs)
- `TagManager` component (create/edit/delete tags, accessible from Settings or a button)
- `TagPicker` inline component (apply tags to a meeting in the detail view and card)
- Filter bar in `HistoryPage` (click a tag to filter list)
- Tag chips displayed on `MeetingCard`

**Out of scope:**
- Per-meeting tag creation (tags are global)
- Custom color via color picker (fixed palette of 10 colors)
- Tag sorting / ordering
- Tag search

## Data Model

### `Tag` struct (new, in `storage/mod.rs`)

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,      // UUID v4
    pub name: String,
    pub color: String,   // one of 10 fixed hex values
}
```

### `Meeting` struct change

```rust
/// Tags aplicadas à reunião (lista de IDs de Tag)
#[serde(default)]
pub tags: Vec<String>,
```

`#[serde(default)]` ensures existing `meetings/*.json` files without `tags` field continue to deserialize correctly (empty vec).

### `tags.json`

Stored at `{app_data_dir}/tags.json` as `Vec<Tag>`.

## Fixed Color Palette (10 colors, Trello-inspired)

| Label | Hex |
|---|---|
| Vermelho | `#ef4444` |
| Laranja | `#f97316` |
| Amarelo | `#eab308` |
| Verde | `#22c55e` |
| Turquesa | `#14b8a6` |
| Azul | `#3b82f6` |
| Índigo | `#6366f1` |
| Roxo | `#a855f7` |
| Rosa | `#ec4899` |
| Cinza | `#6b7280` |

## Architecture

```
storage/mod.rs
  + Tag struct
  + Meeting.tags: Vec<String>
  + load_tags() -> Result<Vec<Tag>>
  + save_tags(tags: &[Tag]) -> Result<()>
  + tags_file_path() -> Result<PathBuf>  (private)

commands.rs
  + get_tags() -> Result<Vec<Tag>, String>
  + save_tags(tags: Vec<Tag>) -> Result<(), String>
  + update_meeting_tags(meeting_id: String, tag_ids: Vec<String>) -> Result<(), String>

main.rs
  + register get_tags, save_tags, update_meeting_tags in invoke_handler

Frontend
  TagManager component   → create/rename/delete/recolor tags
  TagPicker component    → apply/remove tags on a meeting (used in MeetingDetail)
  MeetingCard            → show tag chips (color dot + name)
  HistoryPage            → filter bar: show all existing tags, click = filter
```

## Backend Details

### `tags_file_path()`
```rust
fn tags_file_path() -> Result<PathBuf> {
    Ok(app_data_dir()?.join("tags.json"))
}
```

### `load_tags()`
Returns `Ok(vec![])` if file does not exist.

### `save_tags(tags: &[Tag])`
Serializes to pretty JSON, writes to `tags.json`.

### `update_meeting_tags(meeting_id, tag_ids)`
Loads the meeting → sets `meeting.tags = tag_ids` → saves meeting.

### `get_tags` command
Wraps `load_tags()`, maps error to String.

### `save_tags` command
Receives `Vec<Tag>` from frontend, calls `storage::save_tags`, maps error to String.

## Frontend Components

### `TagManager`

A standalone modal, opened via a "Gerenciar Tags" button inside `SettingsModal`. Shows all tags as a list:
- Each tag row: colored circle + name + rename pencil icon + delete trash icon
- "Nova tag" button at bottom → input for name + color picker (10 swatches) → confirm

### `TagPicker`

A small inline dropdown/popover shown in the **meeting detail view** (expanded view in `HistoryPage`), not on the card itself:
- Lists all tags with checkbox
- Click tag → toggles it on the meeting (calls `update_meeting_tags`)
- Shows currently applied tags as chips above the picker trigger button

### `MeetingCard`

Below the meeting title/date, show tag chips:
- Each chip: small colored dot + tag name
- If no tags: render nothing

### `HistoryPage` Filter Bar

Between the search input and the meeting list, render a horizontal row of tag chips:
- "Todas" chip (default selected, shows all meetings)
- One chip per tag that has at least one meeting
- Click a tag chip → filters list to meetings containing that tag ID
- Active chip has highlighted border/background

## Error Handling

- `get_tags` failure: show empty tag list (no toast)
- `save_tags` failure: show toast error
- `update_meeting_tags` failure: revert optimistic UI update + show toast error

## Testing

- Create a tag → appears in TagManager list and TagPicker
- Apply tag to meeting → tag chip appears on MeetingCard
- Filter by tag → only meetings with that tag appear
- Delete tag → removed from all TagPicker dropdowns; existing meeting.tags IDs remain but chip is not rendered (orphan IDs are silently ignored)
- Old meetings without `tags` field load correctly (empty vec)
