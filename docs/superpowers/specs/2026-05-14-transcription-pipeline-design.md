# Transcription Pipeline Improvements — Design Spec

## Goal

Improve the transcription pipeline with: subtle per-chunk visual feedback, cross-stream deduplication, non-blocking stop signal handling, larger prompt context, and drain hardening.

## Scope

Improvements selected: #1, #2, #3, #5 + drain hardening. Short chunk grouping (#6) deferred.

---

## Backend Changes (`src-tauri/src/commands.rs`)

### #3 — Non-blocking stop during semaphore acquire

**Problem:** `acquire_owned().await` blocks the Phase 1 loop indefinitely when all 3 semaphore slots are taken, preventing `stop_rx` from being checked. On a busy meeting, stop can be delayed several seconds.

**Fix:** Replace the bare `.await` with a `tokio::select!` that races semaphore acquisition against the stop signal:

```rust
let permit = tokio::select! {
    p = Arc::clone(&transcription_sem).acquire_owned() => p.expect("Semaphore closed"),
    _ = async {
        while stop_rx.try_recv().is_err() {
            tokio::task::yield_now().await;
        }
    } => break,
};
```

Chunks already in the channel are not lost — they remain in the `mpsc` buffer and are drained in Phase 2/3. No words are dropped.

### #2 — Cross-stream deduplication

**Problem:** Current Jaccard dedup only compares segments of the same source. When the user speaks while their mic audio also leaks into system capture (or vice versa), the same speech appears as both a "mic" and a "system" segment.

**Fix:** After the existing same-source check, add a cross-stream check:

- Compare against the most recent segment of the **opposite** source
- Only if the timestamp difference is < 3000ms (same conversational moment)
- Jaccard threshold: **0.70** (lower than same-source 0.85, because cross-stream audio differs slightly)
- Minimum word count: 4 (same as existing check)

```rust
let opposite = if source == "mic" { "system" } else { "mic" };
let is_cross_dup = if word_count >= 4 {
    let segs = app_state.segments.lock();
    segs.iter().rev()
        .filter(|s| s.source == opposite)
        .find(|s| timestamp_ms.abs_diff(s.timestamp_ms) < 3000)
        .map(|prev| jaccard_bigrams(&prev.text, &text) >= 0.70)
        .unwrap_or(false)
} else { false };

if is_duplicate || is_cross_dup { /* same dedup path */ }
```

### #5 — Larger prompt context

**Problem:** Whisper prompt uses only the last 50 words of transcript as context, which is insufficient for long meetings.

**Fix:** Increase to **120 words**. The prompt context is built where `whisper_prompt` / `whisper_glossary` are assembled — update the word-count limit from 50 to 120 at that point.

### Drain hardening

**Problem:** Phase 2 timeout is 5 seconds — if the audio thread takes longer to flush its PCM buffer, the drain exits early and some chunks are missed.

**Fix:** Increase Phase 2 `recv_timeout` from `Duration::from_secs(5)` to `Duration::from_secs(15)`. Add a log warning at 10s to make slow flushes visible in logs without aborting.

---

## Frontend Changes

### #1 — Subtle per-chunk processing indicator

**Event payload change:** `transcription-processing` changes from `bool` to:
```ts
{ active: boolean; source: "mic" | "system" | null }
```

**`useTranscription.ts`:** Update the `transcription-processing` listener to parse the new object shape. Track `processingSource: "mic" | "system" | null` in state.

**`TranscriptionPanel.tsx`:** Pass `processingSource` down to `SegmentRow`. When `isLast && processingSource === segment.source`, apply a subtle animated ring:
- mic segments: `ring-1 ring-emerald-400/50 dark:ring-emerald-500/30 animate-pulse-slow`
- system segments: `ring-1 ring-blue-400/50 dark:ring-blue-500/30 animate-pulse-slow`

No header changes. No badges. Only the last card of the active source pulses while the API call is in flight.

**Rust emit sites:** All `app.emit("transcription-processing", ...)` calls updated to emit the new object. Two sites: start of `process_chunk` (emit `{active: true, source}`) and end (emit `{active: false, source: null}`).

---

## Data Flow Summary

```
AudioChunk arrives
  → Phase 1 loop: tokio::select!(semaphore | stop)  [#3]
    → process_chunk()
      → transcribe API call  (prompt context: 120 words)  [#5]
      → same-source Jaccard >= 0.85?  → dedup
      → cross-stream Jaccard >= 0.70, < 3s apart?  → dedup  [#2]
      → emit transcription-update (segment)
      → emit transcription-processing {active, source}  [#1]
  → stop signal → Phase 2 (15s timeout)  [drain hardening]
    → Phase 3: sequential drain of residual chunks
    → Phase 4: re-save meeting, emit meeting-updated
```

---

## Files Modified

- `src-tauri/src/commands.rs` — #2, #3, #5, drain hardening, emit payload change
- `src/hooks/useTranscription.ts` — update `transcription-processing` listener
- `src/components/TranscriptionPanel.tsx` — pass `processingSource`, apply ring to `SegmentRow`

## Files NOT modified

- `src-tauri/src/transcription/mod.rs` — no changes needed
- `src-tauri/src/audio/mod.rs` — no changes needed
- All other components
