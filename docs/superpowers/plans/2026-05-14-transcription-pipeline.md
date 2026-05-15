# Transcription Pipeline Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the transcription pipeline with non-blocking stop handling, cross-stream deduplication, larger prompt context, drain hardening, and subtle per-chunk visual feedback.

**Architecture:** Four backend changes in `commands.rs` (semaphore fix, cross-stream dedup, prompt context, drain timeout) plus a frontend event payload change rippling through `types/index.ts` → `audioCaptureService.ts` → `useAudioCapture.ts` → `TranscriptionPanel.tsx`.

**Tech Stack:** Rust/Tauri (tokio, mpsc, Semaphore), React/TypeScript, Tauri events

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | #3 semaphore fix, #2 cross-stream dedup, #5 prompt context 50→120, drain timeout 5→15s, emit payload change |
| `src/types/index.ts` | `TranscriptionProcessingPayload` type: `boolean` → `{ active: boolean; source: "mic" \| "system" \| null }` |
| `src/services/audioCaptureService.ts` | Update `onTranscriptionProcessing` callback signature |
| `src/hooks/useAudioCapture.ts` | `isProcessing: boolean` → `processingSource: "mic" \| "system" \| null`; update listener |
| `src/pages/MainPage.tsx` | Replace `isProcessing` with `processingSource` in destructure + JSX |
| `src/components/TranscriptionPanel.tsx` | Replace `isProcessing` prop with `processingSource`; pass to `SegmentRow`; add ring animation |

---

### Task 1: Backend — non-blocking stop (#3) + drain hardening

**Files:**
- Modify: `src-tauri/src/commands.rs` (lines ~449-452 for semaphore; line ~483 for drain timeout)

This fixes a bug where `acquire_owned().await` blocks the Phase 1 loop when all 3 semaphore slots are taken, delaying stop by several seconds. Also increases drain timeout from 5s to 15s.

- [ ] **Step 1: Fix semaphore acquire — replace blocking await with select**

In `src-tauri/src/commands.rs`, find this block (around line 449):
```rust
                    let permit = Arc::clone(&transcription_sem)
                        .acquire_owned()
                        .await
                        .expect("Semaphore closed");
```

Replace with:
```rust
                    let permit = tokio::select! {
                        p = Arc::clone(&transcription_sem).acquire_owned() => {
                            p.expect("Semaphore closed")
                        }
                        _ = async {
                            while stop_rx.try_recv().is_err() {
                                tokio::task::yield_now().await;
                            }
                        } => break,
                    };
```

- [ ] **Step 2: Increase drain timeout from 5s to 15s**

In the same file, find Phase 2 (around line 483):
```rust
            match chunk_rx.recv_timeout(std::time::Duration::from_secs(5)) {
```

Replace with:
```rust
            match chunk_rx.recv_timeout(std::time::Duration::from_secs(15)) {
```

- [ ] **Step 3: Build and verify it compiles**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: no errors (warnings ok for now).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "fix(transcription): non-blocking stop during semaphore acquire, drain timeout 15s"
```

---

### Task 2: Backend — cross-stream deduplication (#2)

**Files:**
- Modify: `src-tauri/src/commands.rs` (around lines 366-388, after existing same-source dedup block)

After the existing `is_duplicate` check (same-source Jaccard), add a cross-stream check. The existing block ends with `if is_duplicate { ... return false; }`. We need to expand this.

- [ ] **Step 1: Add cross-stream dedup after same-source check**

Find the existing dedup block (around line 366):
```rust
                        let is_duplicate = if word_count < 4 {
                            false
                        } else {
                            let segs = app_state.segments.lock();
                            segs.iter()
                                .rev()
                                .find(|s| s.source == source)
                                .map(|prev| jaccard_bigrams(&prev.text, &text) >= 0.85)
                                .unwrap_or(false)
                        };

                        if is_duplicate {
                            log::debug!(
                                "Segment deduped (source={}): {:?}",
                                source,
                                &text[..text.len().min(50)]
                            );
                            let _ = app.emit("transcription-processing", false);
                            return false;
                        }
```

Replace with:
```rust
                        let is_duplicate = if word_count < 4 {
                            false
                        } else {
                            let segs = app_state.segments.lock();
                            segs.iter()
                                .rev()
                                .find(|s| s.source == source)
                                .map(|prev| jaccard_bigrams(&prev.text, &text) >= 0.85)
                                .unwrap_or(false)
                        };

                        let is_cross_dup = if !is_duplicate && word_count >= 4 {
                            let opposite = if source == "mic" { "system" } else { "mic" };
                            let segs = app_state.segments.lock();
                            segs.iter()
                                .rev()
                                .filter(|s| s.source == opposite)
                                .find(|s| timestamp_ms.abs_diff(s.timestamp_ms) < 3000)
                                .map(|prev| jaccard_bigrams(&prev.text, &text) >= 0.70)
                                .unwrap_or(false)
                        } else {
                            false
                        };

                        if is_duplicate || is_cross_dup {
                            log::debug!(
                                "Segment deduped (source={}, cross={}): {:?}",
                                source, is_cross_dup,
                                &text[..text.len().min(50)]
                            );
                            let _ = app.emit("transcription-processing", false);
                            return false;
                        }
```

- [ ] **Step 2: Build and verify**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(transcription): cross-stream deduplication (threshold 0.70, window 3s)"
```

---

### Task 3: Backend — prompt context 50→120 words (#5)

**Files:**
- Modify: `src-tauri/src/commands.rs` (around line 299)

- [ ] **Step 1: Increase context word limit**

Find (around line 298):
```rust
                let context_words: String = {
                    let words: Vec<&str> = accumulated.split_whitespace().collect();
                    let start = words.len().saturating_sub(50);
                    words[start..].join(" ")
                };
```

Replace with:
```rust
                let context_words: String = {
                    let words: Vec<&str> = accumulated.split_whitespace().collect();
                    let start = words.len().saturating_sub(120);
                    words[start..].join(" ")
                };
```

- [ ] **Step 2: Build and verify**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(transcription): increase whisper prompt context from 50 to 120 words"
```

---

### Task 4: Backend — update transcription-processing emit payload

**Files:**
- Modify: `src-tauri/src/commands.rs` — all `app.emit("transcription-processing", ...)` calls

Currently the event emits a bare `bool`. Change to emit `{active: bool, source: Option<&str>}`.

There are two emit sites in `process_chunk`:
1. Top of function: `app.emit("transcription-processing", true)` → emit `{active: true, source}`
2. End of function and early returns: `app.emit("transcription-processing", false)` → emit `{active: false, source: null}`

- [ ] **Step 1: Update the emit at the top of process_chunk**

Find (around line 283):
```rust
            let _ = app.emit("transcription-processing", true);
```

Replace with:
```rust
            let source_str = match chunk.source {
                AudioSource::Microphone => "mic",
                AudioSource::System => "system",
            };
            let _ = app.emit("transcription-processing", serde_json::json!({
                "active": true,
                "source": source_str
            }));
```

- [ ] **Step 2: Update all false-emits in process_chunk**

There are multiple `app.emit("transcription-processing", false)` calls in `process_chunk` (WAV error path, dedup path, end of function). Replace ALL of them with:
```rust
            let _ = app.emit("transcription-processing", serde_json::json!({
                "active": false,
                "source": null
            }));
```

Find them by searching for `transcription-processing", false` in `commands.rs`. There should be 3-4 occurrences — replace every one inside `process_chunk`.

- [ ] **Step 3: Build and verify**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(transcription): transcription-processing event now includes source field"
```

---

### Task 5: Frontend — update type + service + hook

**Files:**
- Modify: `src/types/index.ts` (line 183)
- Modify: `src/services/audioCaptureService.ts` (lines 79-88)
- Modify: `src/hooks/useAudioCapture.ts` (lines 22, 48, 73-75, 181)

- [ ] **Step 1: Update the type in types/index.ts**

Find (line 183):
```ts
export type TranscriptionProcessingPayload = boolean;
```

Replace with:
```ts
export type TranscriptionProcessingPayload = {
  active: boolean;
  source: "mic" | "system" | null;
};
```

- [ ] **Step 2: Update audioCaptureService.ts callback signature**

Find (lines 79-88):
```ts
export async function onTranscriptionProcessing(
  callback: (isProcessing: boolean) => void
): Promise<UnlistenFn> {
  return listen<TranscriptionProcessingPayload>(
    "transcription-processing",
    (event) => {
      callback(event.payload);
    }
  );
}
```

Replace with:
```ts
export async function onTranscriptionProcessing(
  callback: (payload: TranscriptionProcessingPayload) => void
): Promise<UnlistenFn> {
  return listen<TranscriptionProcessingPayload>(
    "transcription-processing",
    (event) => {
      callback(event.payload);
    }
  );
}
```

- [ ] **Step 3: Update useAudioCapture.ts**

In `src/hooks/useAudioCapture.ts`:

1. In the `AudioCaptureState` interface (around line 22), replace:
```ts
  isProcessing: boolean;
```
with:
```ts
  processingSource: "mic" | "system" | null;
```

2. In state initialization (around line 48), replace:
```ts
  const [isProcessing, setIsProcessing] = useState(false);
```
with:
```ts
  const [processingSource, setProcessingSource] = useState<"mic" | "system" | null>(null);
```

3. In the listener setup (around line 73-75), replace:
```ts
      const unlistenProcessing = await onTranscriptionProcessing((processing) => {
        if (isMounted) setIsProcessing(processing);
      });
```
with:
```ts
      const unlistenProcessing = await onTranscriptionProcessing((payload) => {
        if (isMounted) setProcessingSource(payload.active ? payload.source : null);
      });
```

4. In the `recording-stopped` handler (around line 87), replace:
```ts
          setIsProcessing(false);
```
with:
```ts
          setProcessingSource(null);
```

5. In the return object (around line 181), replace `isProcessing` with `processingSource`:
```ts
    { isCapturing, audioLevel, micLevel, micMuted, processingSource, error, duration, lastMeetingId, isPaused },
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: errors only in MainPage.tsx and TranscriptionPanel.tsx (we fix those in Task 6). No errors in types, service, or hook files.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/services/audioCaptureService.ts src/hooks/useAudioCapture.ts
git commit -m "feat(transcription): update processing event type to include source"
```

---

### Task 6: Frontend — visual indicator in TranscriptionPanel

**Files:**
- Modify: `src/pages/MainPage.tsx`
- Modify: `src/components/TranscriptionPanel.tsx`

- [ ] **Step 1: Update MainPage.tsx**

In `src/pages/MainPage.tsx`, find the destructure (around line 38):
```ts
  const { isCapturing, audioLevel, micLevel, micMuted, isProcessing, error, duration, isPaused } = captureState;
```

Replace with:
```ts
  const { isCapturing, audioLevel, micLevel, micMuted, processingSource, error, duration, isPaused } = captureState;
```

Find the status text that references `isProcessing` (around line 150):
```tsx
                  {isPaused ? "Pausado" : isProcessing ? "Transcrevendo chunk..." : "Aguardando fala"}
```

Replace with:
```tsx
                  {isPaused ? "Pausado" : processingSource ? "Transcrevendo chunk..." : "Aguardando fala"}
```

Find the `TranscriptionPanel` usage (around line 337):
```tsx
          isProcessing={isProcessing}
```

Replace with:
```tsx
          processingSource={processingSource}
```

- [ ] **Step 2: Update TranscriptionPanel props interface and header**

In `src/components/TranscriptionPanel.tsx`, find the interface (around line 54):
```ts
interface TranscriptionPanelProps {
  segments: TranscriptSegment[];
  legacyTranscript?: string;
  meetingId?: string | null;
  isCapturing: boolean;
  isProcessing: boolean;
  duration?: number;
  className?: string;
}
```

Replace with:
```ts
interface TranscriptionPanelProps {
  segments: TranscriptSegment[];
  legacyTranscript?: string;
  meetingId?: string | null;
  isCapturing: boolean;
  processingSource?: "mic" | "system" | null;
  duration?: number;
  className?: string;
}
```

In the component destructure (around line 206):
```ts
export const TranscriptionPanel: React.FC<TranscriptionPanelProps> = ({
  segments,
  legacyTranscript,
  meetingId,
  isCapturing,
  isProcessing,
  duration = 0,
  className,
}) => {
```

Replace with:
```ts
export const TranscriptionPanel: React.FC<TranscriptionPanelProps> = ({
  segments,
  legacyTranscript,
  meetingId,
  isCapturing,
  processingSource = null,
  duration = 0,
  className,
}) => {
```

In the header where `ProcessingBadge` is rendered (around line 275):
```tsx
          {isProcessing && <ProcessingBadge />}
```

Replace with:
```tsx
          {processingSource && <ProcessingBadge />}
```

- [ ] **Step 3: Update SegmentRow to accept and use processingSource**

In `TranscriptionPanel.tsx`, find the `SegmentRowProps` interface (around line 74):
```ts
interface SegmentRowProps {
  segment: TranscriptSegment;
  index: number;
  isLast: boolean;
  isCapturing: boolean;
  meetingId: string | null | undefined;
  showSimultaneousMarker: boolean;
}
```

Replace with:
```ts
interface SegmentRowProps {
  segment: TranscriptSegment;
  index: number;
  isLast: boolean;
  isCapturing: boolean;
  meetingId: string | null | undefined;
  showSimultaneousMarker: boolean;
  processingSource: "mic" | "system" | null;
}
```

Update `SegmentRow` component signature (around line 83):
```ts
const SegmentRow: React.FC<SegmentRowProps> = ({
  segment,
  index: _index,
  isLast,
  isCapturing,
  meetingId,
  showSimultaneousMarker,
}) => {
```

Replace with:
```ts
const SegmentRow: React.FC<SegmentRowProps> = ({
  segment,
  index: _index,
  isLast,
  isCapturing,
  meetingId,
  showSimultaneousMarker,
  processingSource,
}) => {
```

- [ ] **Step 4: Add animated ring to the last active segment**

In `SegmentRow`, find the main `<div>` with className (around line 155):
```tsx
      <div
        className={clsx(
          "py-2 px-3 rounded-lg group",
          !isCapturing && "cursor-text hover:ring-1 hover:ring-surface-200 dark:hover:ring-surface-700",
          isMic
            ? "bg-emerald-50/60 dark:bg-emerald-500/5 border-l-2 border-emerald-400 dark:border-emerald-500/40"
            : "bg-blue-50/60 dark:bg-blue-500/5 border-l-2 border-blue-400 dark:border-blue-500/40"
        )}
        onClick={handleClick}
      >
```

Replace with:
```tsx
      <div
        className={clsx(
          "py-2 px-3 rounded-lg group transition-shadow duration-150",
          !isCapturing && "cursor-text hover:ring-1 hover:ring-surface-200 dark:hover:ring-surface-700",
          isMic
            ? "bg-emerald-50/60 dark:bg-emerald-500/5 border-l-2 border-emerald-400 dark:border-emerald-500/40"
            : "bg-blue-50/60 dark:bg-blue-500/5 border-l-2 border-blue-400 dark:border-blue-500/40",
          isLast && processingSource === "mic" && segment.source === "mic" &&
            "ring-1 ring-emerald-400/50 dark:ring-emerald-500/30 animate-pulse-slow",
          isLast && processingSource === "system" && segment.source === "system" &&
            "ring-1 ring-blue-400/50 dark:ring-blue-500/30 animate-pulse-slow",
        )}
        onClick={handleClick}
      >
```

- [ ] **Step 5: Pass processingSource when rendering SegmentRow**

Find the `SegmentRow` usage in the `segments.map()` (around line 327):
```tsx
                <SegmentRow
                  key={seg.timestamp_ms.toString()}
                  segment={seg}
                  index={i}
                  isLast={i === segments.length - 1}
                  isCapturing={isCapturing}
                  meetingId={meetingId}
                  showSimultaneousMarker={showSimultaneous}
                />
```

Replace with:
```tsx
                <SegmentRow
                  key={seg.timestamp_ms.toString()}
                  segment={seg}
                  index={i}
                  isLast={i === segments.length - 1}
                  isCapturing={isCapturing}
                  meetingId={meetingId}
                  showSimultaneousMarker={showSimultaneous}
                  processingSource={processingSource}
                />
```

- [ ] **Step 6: Verify TypeScript compiles clean**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 7: Check HistoryPage.tsx still compiles**

`HistoryPage.tsx` passes `isProcessing={false}` to `TranscriptionPanel`. Since we renamed the prop, find and update it:

In `src/pages/HistoryPage.tsx` (around line 469):
```tsx
          isProcessing={false}
```

Replace with:
```tsx
          processingSource={null}
```

- [ ] **Step 8: Verify TypeScript compiles clean again**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/pages/MainPage.tsx src/components/TranscriptionPanel.tsx src/pages/HistoryPage.tsx
git commit -m "feat(ui): subtle per-chunk processing indicator on active segment card"
```

---

### Task 7: Verify full build

- [ ] **Step 1: Run full Rust build**

```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error" | head -20
```

Expected: no errors printed.

- [ ] **Step 2: Run frontend build**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Start dev server and manually verify**

```bash
npm run tauri dev
```

Manual checks:
1. Start a recording — the last mic/system segment card should pulse subtly while a chunk is being transcribed
2. Say something while the mic is active — the emerald ring should appear on the last mic segment briefly
3. Stop recording — verify the UI updates correctly (ring disappears, `processingSource` resets to null)
4. Check that `HistoryPage` meeting detail view still loads without errors
5. Open the compliance overlay — stop from there should still stop the main window UI

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -p
git commit -m "fix: address issues found during manual verification"
```
