# Mic Calibration Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three enhancements to the mic calibration flow: named calibration history with restore, quick recalibration (threshold-only), and a mic health badge during recording.

**Architecture:** Feature 1 adds `CalibrationSnapshot` to `AppSettings` in Rust/storage and TypeScript types, then wires save/restore in the wizard and SettingsModal. Feature 2 adds a button in SettingsModal that calls the existing `measure_ambient_noise` command and updates one field. Feature 3 adds a colored icon to `AudioIndicator` driven by the existing `level` prop.

**Tech Stack:** Rust (serde, storage/mod.rs), React + TypeScript (Tauri 2 invoke), Tailwind CSS, lucide-react

---

## File Map

| File | Change |
|---|---|
| `src-tauri/src/storage/mod.rs` | Add `CalibrationSnapshot` struct + `calibration_snapshots: Vec<CalibrationSnapshot>` to `AppSettings` + `Default` |
| `src/types/index.ts` | Add `CalibrationSnapshot` TS interface + `calibration_snapshots` field to `AppSettings` |
| `src/components/MicCalibrationWizard.tsx` | Add optional name input at summary step; call `onSaveSnapshot` if name entered |
| `src/components/SettingsModal.tsx` | Show snapshot cards with Restore; add "Ajuste rápido" button |
| `src/components/AudioIndicator.tsx` | Add `MicHealthBadge` sub-component; render when `isActive` and `level` provided |

---

## Task 1: Add CalibrationSnapshot to Rust AppSettings

**Files:**
- Modify: `src-tauri/src/storage/mod.rs`

Context: `AppSettings` is defined at line 128 in `src-tauri/src/storage/mod.rs`. It derives `Debug, Serialize, Deserialize, Clone`. All new fields use `#[serde(default)]` so existing `settings.json` files without the field don't break.

- [ ] **Step 1: Read the current AppSettings struct**

Open `src-tauri/src/storage/mod.rs` and find the `AppSettings` struct. Look at the end of it (around line 224+) to find where to append the new field.

- [ ] **Step 2: Add `CalibrationSnapshot` struct and field to `AppSettings`**

Add the following struct **before** `AppSettings` (place it near line 125, before the `AppSettings` block):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationSnapshot {
    pub name: String,
    pub created_at: String,
    pub mic_auto_gain: bool,
    pub mic_gain_max: f32,
    pub mic_silence_threshold: f32,
    pub mic_noise_gate_ratio: f32,
    pub mic_noise_gate_hold_secs: f32,
}
```

Then add this field to `AppSettings` (append at the end of the struct, before the closing `}`):

```rust
    /// Perfis de calibração salvos pelo usuário (max 3).
    #[serde(default)]
    pub calibration_snapshots: Vec<CalibrationSnapshot>,
```

- [ ] **Step 3: Add `calibration_snapshots: vec![]` to the `Default` impl**

Find the `impl Default for AppSettings` block (around line 340). Add:

```rust
calibration_snapshots: vec![],
```

- [ ] **Step 4: Verify it compiles**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

Expected: no errors (warnings OK).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/mod.rs
git commit -m "feat(storage): add CalibrationSnapshot type and field to AppSettings"
```

---

## Task 2: Add CalibrationSnapshot to TypeScript types

**Files:**
- Modify: `src/types/index.ts`

Context: `AppSettings` interface is at line 93 of `src/types/index.ts`. Add the TS interface and extend `AppSettings`.

- [ ] **Step 1: Add `CalibrationSnapshot` interface**

In `src/types/index.ts`, add before the `AppSettings` interface (around line 91):

```ts
export interface CalibrationSnapshot {
  name: string;
  created_at: string;
  mic_auto_gain: boolean;
  mic_gain_max: number;
  mic_silence_threshold: number;
  mic_noise_gate_ratio: number;
  mic_noise_gate_hold_secs: number;
}
```

- [ ] **Step 2: Add field to `AppSettings`**

Inside the `AppSettings` interface, at the end (before the closing `}`), add:

```ts
  /** Perfis de calibração salvos (max 3) */
  calibration_snapshots: CalibrationSnapshot[];
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add CalibrationSnapshot interface to AppSettings"
```

---

## Task 3: Wizard — save named snapshot on Apply

**Files:**
- Modify: `src/components/MicCalibrationWizard.tsx`

Context: The wizard's `MicCalibrationWizardProps` has `settings: AppSettings` and `onApply: (patch: Partial<AppSettings>) => void`. The summary step renders at the `step === "summary"` condition (around line 522). `handleApply` calls `onApply(patch)` then `onClose()`.

The wizard needs a new prop `onSaveSnapshot?: (snapshot: CalibrationSnapshot) => void`. At the summary step, show an optional text input. When apply is clicked and the name is non-empty, call `onSaveSnapshot` with a snapshot built from the calibration result + current timestamp.

- [ ] **Step 1: Add import and prop**

At the top of the file, add the import:
```ts
import type { AppSettings, CalibrationSnapshot } from "@/types";
```
(replace the existing `import type { AppSettings } from "@/types";`)

Add `onSaveSnapshot?: (snapshot: CalibrationSnapshot) => void;` to `MicCalibrationWizardProps`.

- [ ] **Step 2: Add `profileName` state**

Inside the component, add:
```ts
const [profileName, setProfileName] = useState("");
```

- [ ] **Step 3: Add name input to summary step**

In the summary step JSX (just before the "Descartar" / "Aplicar" button row, around line 529), insert:

```tsx
<div>
  <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
    Salvar como perfil (opcional)
  </label>
  <input
    type="text"
    value={profileName}
    onChange={(e) => setProfileName(e.target.value)}
    placeholder="ex: Escritório, Casa, Reunião fora"
    maxLength={40}
    className="w-full px-3 py-2 rounded-xl text-sm bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-surface-800 dark:text-surface-100 placeholder-surface-400 focus:outline-none focus:ring-2 focus:ring-primary-400"
  />
</div>
```

- [ ] **Step 4: Save snapshot in `handleApply`**

Find `handleApply` (the function called by the "Aplicar configurações" button). After the `onApply(patch)` call, add:

```ts
if (profileName.trim() && calibration && onSaveSnapshot) {
  const now = new Date().toISOString();
  onSaveSnapshot({
    name: profileName.trim(),
    created_at: now,
    mic_auto_gain: calibration.mic_auto_gain,
    mic_gain_max: calibration.mic_gain_max,
    mic_silence_threshold: calibration.mic_silence_threshold,
    mic_noise_gate_ratio: calibration.mic_noise_gate_ratio,
    mic_noise_gate_hold_secs: calibration.mic_noise_gate_hold_secs,
  });
}
```

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/MicCalibrationWizard.tsx
git commit -m "feat(wizard): add optional profile name input at summary step"
```

---

## Task 4: SettingsModal — snapshot cards + Quick Recalibration button

**Files:**
- Modify: `src/components/SettingsModal.tsx`

Context: The `SettingsPanel` component has `settings` state from `getSettings()` and `updateSetting(key, value)` helper, and `saveSettings` from `storageService`. The `MicCalibrationWizard` is opened with `showMicTuner` state (line 981). The calibration wizard button is at line 336 (`setShowMicTuner(true)`).

The existing `onApply` handler on line 984 already calls `updateSetting` for each patched key. We need to:
1. Wire `onSaveSnapshot` to save a snapshot (max 3, remove oldest).
2. Show existing snapshots as cards with a Restore button.
3. Add an "Ajuste rápido" button that calls `measure_ambient_noise`, computes new threshold, saves.

- [ ] **Step 1: Add `quickRecalibrating` state**

Inside `SettingsPanel`, add:
```ts
const [quickRecalibrating, setQuickRecalibrating] = useState(false);
```

- [ ] **Step 2: Add `handleSaveSnapshot` function**

Inside `SettingsPanel`, add this function:

```ts
const handleSaveSnapshot = useCallback((snapshot: CalibrationSnapshot) => {
  const existing = settings.calibration_snapshots ?? [];
  const updated = [...existing, snapshot].slice(-3); // keep last 3
  updateSetting("calibration_snapshots", updated);
}, [settings.calibration_snapshots, updateSetting]);
```

Note: `updateSetting` already calls `saveSettings` internally (check the existing pattern — if it doesn't auto-save, call `saveSettings({ ...settings, calibration_snapshots: updated })` directly after setting).

- [ ] **Step 3: Add `handleRestoreSnapshot` function**

```ts
const handleRestoreSnapshot = useCallback((snap: CalibrationSnapshot) => {
  updateSetting("mic_auto_gain", snap.mic_auto_gain);
  updateSetting("mic_gain_max", snap.mic_gain_max);
  updateSetting("mic_silence_threshold", snap.mic_silence_threshold);
  updateSetting("mic_noise_gate_ratio", snap.mic_noise_gate_ratio);
  updateSetting("mic_noise_gate_hold_secs", snap.mic_noise_gate_hold_secs);
}, [updateSetting]);
```

- [ ] **Step 4: Add `handleQuickRecal` function**

```ts
const handleQuickRecal = useCallback(async () => {
  setQuickRecalibrating(true);
  try {
    const result = await invoke<{ avg_rms: number }>("measure_ambient_noise");
    const newThreshold = Math.min(0.025, Math.max(0.001, result.avg_rms * 2.5));
    updateSetting("mic_silence_threshold", Math.round(newThreshold * 10000) / 10000);
  } catch (e) {
    console.error("Quick recal failed:", e);
  } finally {
    setQuickRecalibrating(false);
  }
}, [updateSetting]);
```

- [ ] **Step 5: Add import for CalibrationSnapshot**

Add to the existing import from `@/types`:
```ts
import type { AppSettings, AudioDevice, MeetingType, CalibrationSnapshot } from "@/types";
```

- [ ] **Step 6: Wire `onSaveSnapshot` on `MicCalibrationWizard`**

At line ~984, update the wizard usage:

```tsx
{showMicTuner && (
  <MicCalibrationWizard
    settings={settings}
    onApply={(patch) => {
      (Object.keys(patch) as Array<keyof AppSettings>).forEach((key) => {
        updateSetting(key, patch[key] as AppSettings[typeof key]);
      });
    }}
    onSaveSnapshot={handleSaveSnapshot}
    onClose={() => setShowMicTuner(false)}
  />
)}
```

- [ ] **Step 7: Add snapshot cards + Quick Recal button in the mic section**

Find the calibration button block (around line 335–349). Replace the single "Calibrar microfone" button with:

```tsx
{settings.capture_microphone && (
  <div className="mt-3 space-y-2">
    {/* Snapshot cards */}
    {(settings.calibration_snapshots ?? []).length > 0 && (
      <div className="space-y-1.5">
        {(settings.calibration_snapshots ?? []).map((snap, i) => (
          <div
            key={i}
            className="flex items-center justify-between px-3 py-2 rounded-xl bg-surface-50 dark:bg-surface-800/50 border border-surface-100 dark:border-surface-700/50"
          >
            <div>
              <p className="text-xs font-semibold text-surface-700 dark:text-surface-200">
                {snap.name}
              </p>
              <p className="text-[10px] text-surface-400">
                {new Date(snap.created_at).toLocaleDateString("pt-BR")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleRestoreSnapshot(snap)}
              className="text-xs font-semibold text-primary-500 hover:text-primary-600 transition-colors"
            >
              Restaurar
            </button>
          </div>
        ))}
      </div>
    )}

    {/* Button row */}
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => setShowMicTuner(true)}
        className={clsx(
          "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all",
          "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          "border border-emerald-200 dark:border-emerald-500/20 hover:bg-emerald-100 dark:hover:bg-emerald-500/20",
          "active:scale-[0.98]"
        )}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        Calibrar microfone
      </button>
      <button
        type="button"
        onClick={handleQuickRecal}
        disabled={quickRecalibrating}
        className={clsx(
          "flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all",
          "bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-300",
          "border border-surface-200 dark:border-surface-700 hover:bg-surface-100 dark:hover:bg-surface-700",
          "active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        )}
      >
        {quickRecalibrating ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Zap className="w-3.5 h-3.5" />
        )}
        {quickRecalibrating ? "Medindo..." : "Ajuste rápido"}
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 8: Add missing imports**

At the top of `SettingsModal.tsx`, add `Loader2` and `Zap` to the lucide-react import:

```ts
import {
  // ... existing ...
  Loader2,
  Zap,
} from "lucide-react";
```

Also add `useCallback` to the React import if not already there.

- [ ] **Step 9: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 10: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat(settings): add calibration snapshot cards, restore, and quick recal button"
```

---

## Task 5: Mic Health Badge in AudioIndicator

**Files:**
- Modify: `src/components/AudioIndicator.tsx`

Context: `AudioIndicator` already receives `level?: number` (0.0–1.0) and `isActive: boolean`. The bars are rendered in a flex container. We need a small colored mic icon appended after the bars, shown only when `isActive` is true.

- [ ] **Step 1: Add `MicHealthBadge` sub-component**

At the bottom of `src/components/AudioIndicator.tsx`, add:

```tsx
function MicHealthBadge({ level }: { level: number }) {
  const [tooltipVisible, setTooltipVisible] = useState(false);

  let color: string;
  let tooltip: string | null;

  if (level < 0.04) {
    color = "text-yellow-500";
    tooltip = "Microfone muito baixo";
  } else if (level > 0.7) {
    color = "text-red-500";
    tooltip = "Microfone muito alto";
  } else {
    color = "text-emerald-500";
    tooltip = null;
  }

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        className={clsx("p-0.5 rounded transition-colors", color)}
        onMouseEnter={() => setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        aria-label={tooltip ?? "Microfone ideal"}
      >
        <Mic className="w-3 h-3" />
      </button>
      {tooltipVisible && tooltip && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[10px] font-medium bg-surface-800 dark:bg-surface-100 text-white dark:text-surface-900 rounded-lg whitespace-nowrap shadow-lg pointer-events-none">
          {tooltip}
        </span>
      )}
    </div>
  );
}
```

Add `import { useState } from "react";` if not already imported (it's already imported as `React` — use destructured import or `React.useState`). Since the file already has `import React from "react"`, use `React.useState` or add `useState` to the import.

- [ ] **Step 2: Add Mic icon import**

Add `Mic` to the lucide-react import at the top of `AudioIndicator.tsx`:

```ts
import { Mic } from "lucide-react";
```

- [ ] **Step 3: Render badge inside `AudioIndicator`**

In the `AudioIndicator` component return, after the closing `)}` of the bars map, and before the closing `</div>`, add:

```tsx
{isActive && <MicHealthBadge level={level} />}
```

The full return becomes:
```tsx
return (
  <div
    className={clsx("flex items-center gap-0.5", className)}
    aria-label={isActive ? "Capturando áudio" : "Microfone inativo"}
  >
    {Array.from({ length: NUM_BARS }).map((_, i) => (
      <div
        key={i}
        className={clsx(
          widthClasses[size],
          heightClasses[size],
          "rounded-full origin-bottom transition-all duration-100",
          isActive
            ? "bg-primary-500"
            : "bg-surface-300 dark:bg-surface-600"
        )}
        style={{
          ...getBarStyle(i),
          animationName: isActive ? "wave" : "none",
          animationDuration: "0.8s",
          animationTimingFunction: "ease-in-out",
          animationIterationCount: "infinite",
          animationDelay: `${i * 0.1}s`,
        }}
      />
    ))}
    {isActive && <MicHealthBadge level={level} />}
  </div>
);
```

- [ ] **Step 4: Add useState import**

At the top of `AudioIndicator.tsx`, change:
```ts
import React from "react";
```
to:
```ts
import React, { useState } from "react";
```

And update `MicHealthBadge` to use `useState` directly instead of `React.useState`.

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/AudioIndicator.tsx
git commit -m "feat(audio): add mic health badge with color-coded level indicator"
```

---

## Task 6: Verify full build

- [ ] **Step 1: Run frontend build**

```bash
npm run build 2>&1 | tail -30
```

Expected: Build completed without errors.

- [ ] **Step 2: Run Rust check**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit if any fixes were needed**

```bash
git add -p
git commit -m "fix: resolve build issues from mic calibration enhancements"
```
