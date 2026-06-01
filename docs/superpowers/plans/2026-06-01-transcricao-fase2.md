# Transcription Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve transcription quality via Silero ONNX VAD (with fallback), auto-calibration in the first 2 s, smarter context prompts (last complete sentence instead of 120 words), and parallel drain.

**Architecture:** `SileroVad` lives in `audio/silero.rs` and is owned by `SmartChunker`. Calibration state and result are tracked inside `SmartChunker`; when done, the result is stored in `AudioCaptureState` and emitted as a Tauri event from the audio-level polling task in `commands.rs`. Prompt context is extracted by a pure helper function. Drain uses `tokio::task::JoinSet`.

**Tech Stack:** Rust/Tauri v2, `ort = "2"` (ONNX Runtime with `download-binaries` + `ndarray` features), `ndarray = "0.15"`, `tokio::task::JoinSet`.

---

## File Map

| Status | Path | What changes |
|--------|------|--------------|
| **Create** | `src-tauri/src/audio/silero.rs` | `SileroVad` struct — load model, predict, reset |
| **Create** | `src-tauri/resources/silero_vad.onnx` | Download from snakers4/silero-vad (user action) |
| **Modify** | `src-tauri/Cargo.toml` | Add `ort`, `ndarray` |
| **Modify** | `src-tauri/tauri.conf.json` | Add `bundle.resources` |
| **Modify** | `src-tauri/src/audio/resample.rs` | Make `resample_linear` pub(crate) |
| **Modify** | `src-tauri/src/audio/chunker.rs` | Add `SileroVad` + `CalibrationState` + `CalibrationResult` |
| **Modify** | `src-tauri/src/audio/mod.rs` | Export `silero` module; add `calibration_result` to `AudioCaptureState`; wire up in mic thread |
| **Modify** | `src-tauri/src/commands.rs` | Emit `calibration-done`; replace 120-word context with `last_sentence_context`; parallel drain |

---

## Task 1: Download Silero model + add Cargo dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/resources/` directory (user action)

- [ ] **Step 1: Download the Silero VAD ONNX model**

  Open a browser and go to:
  `https://github.com/snakers4/silero-vad/raw/master/files/silero_vad.onnx`
  Save the file to `src-tauri/resources/silero_vad.onnx` (create the `resources/` directory).
  Verify the file is ~2 MB.

- [ ] **Step 2: Add dependencies to Cargo.toml**

  In `src-tauri/Cargo.toml`, after the `rubato` line (currently line ~52), add:

  ```toml
  # Silero VAD — ONNX Runtime + ndarray
  ort     = { version = "2", features = ["download-binaries", "ndarray"] }
  ndarray = "0.15"
  ```

- [ ] **Step 3: Run cargo check to verify dependency resolution**

  ```
  cargo check --manifest-path src-tauri/Cargo.toml
  ```

  Expected: resolves without error (may download ORT binaries on first run, which takes ~30 s).

- [ ] **Step 4: Add bundle.resources to tauri.conf.json**

  In `src-tauri/tauri.conf.json`, inside the `"bundle"` object (after the `"icon"` array), add:

  ```json
  "resources": ["resources/silero_vad.onnx"],
  ```

  Full `bundle` section result:
  ```json
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ],
    "resources": ["resources/silero_vad.onnx"],
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
  ```

- [ ] **Step 5: Commit**

  ```
  git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/resources/silero_vad.onnx
  git commit -m "chore(deps): add ort + ndarray for Silero VAD; bundle model"
  ```

---

## Task 2: SileroVad module

**Files:**
- Create: `src-tauri/src/audio/silero.rs`

- [ ] **Step 1: Create silero.rs with the failing tests first**

  Create `src-tauri/src/audio/silero.rs`:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use std::path::Path;

      fn model_path() -> std::path::PathBuf {
          // Adjust relative path from workspace root
          std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
              .join("resources")
              .join("silero_vad.onnx")
      }

      #[test]
      fn test_load_model() {
          let path = model_path();
          if !path.exists() {
              eprintln!("Skipping: model not found at {:?}", path);
              return;
          }
          let vad = SileroVad::load(&path);
          assert!(vad.is_ok(), "Model load failed: {:?}", vad.err());
      }

      #[test]
      fn test_silence_gives_low_probability() {
          let path = model_path();
          if !path.exists() { return; }
          let mut vad = SileroVad::load(&path).unwrap();
          let silence = vec![0.0f32; 512];
          let prob = vad.predict(&silence);
          assert!(prob < 0.5, "Silence should give low prob, got {:.3}", prob);
      }

      #[test]
      fn test_predict_returns_valid_range() {
          let path = model_path();
          if !path.exists() { return; }
          let mut vad = SileroVad::load(&path).unwrap();
          // Sine wave at 200 Hz (not reliable speech, but valid input)
          let samples: Vec<f32> = (0..512)
              .map(|i| (i as f32 / 16000.0 * 200.0 * 2.0 * std::f32::consts::PI).sin() * 0.5)
              .collect();
          let prob = vad.predict(&samples);
          assert!(prob >= 0.0 && prob <= 1.0, "Prob out of range: {}", prob);
      }

      #[test]
      fn test_reset_clears_state() {
          let path = model_path();
          if !path.exists() { return; }
          let mut vad = SileroVad::load(&path).unwrap();
          let silence = vec![0.0f32; 512];
          vad.predict(&silence);
          vad.reset(); // should not panic
      }
  }
  ```

- [ ] **Step 2: Run tests to confirm they fail (model check passes, struct missing)**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting silero -- --nocapture
  ```

  Expected: compilation error — `SileroVad` not defined yet.

- [ ] **Step 3: Implement SileroVad above the test module**

  Replace the file content with the full implementation:

  ```rust
  /// audio/silero.rs
  /// Silero VAD v4 — wrapper around the ONNX model.
  /// Processes 512-sample frames at 16 kHz and returns speech probability [0.0, 1.0].
  /// Stateful: maintains LSTM hidden states between calls; call reset() between utterances.
  use std::path::Path;
  use anyhow::Result;
  use ndarray::{Array1, Array2, Array3};

  const CHUNK_SIZE: usize = 512; // 32 ms @ 16 kHz — required by Silero v4
  const H_SIZE: usize = 128;     // 2 × 1 × 64 flattened

  pub struct SileroVad {
      session: ort::Session,
      h: Vec<f32>,
      c: Vec<f32>,
  }

  impl SileroVad {
      pub fn load(model_path: &Path) -> Result<Self> {
          let session = ort::Session::builder()?
              .commit_from_file(model_path)?;
          Ok(Self {
              session,
              h: vec![0.0f32; H_SIZE],
              c: vec![0.0f32; H_SIZE],
          })
      }

      /// Feed `samples` (any length) as 512-sample frames; return mean speech probability.
      /// Pads the last frame with zeros if shorter than 512 samples.
      pub fn predict(&mut self, samples: &[f32]) -> f32 {
          if samples.is_empty() {
              return 0.0;
          }
          let mut total = 0.0f32;
          let mut count = 0usize;
          for chunk in samples.chunks(CHUNK_SIZE) {
              let mut frame = chunk.to_vec();
              frame.resize(CHUNK_SIZE, 0.0);
              if let Ok(p) = self.run_frame(&frame) {
                  total += p;
                  count += 1;
              }
          }
          if count == 0 { 0.0 } else { total / count as f32 }
      }

      fn run_frame(&mut self, frame: &[f32]) -> Result<f32> {
          let input = Array2::<f32>::from_shape_vec([1, CHUNK_SIZE], frame.to_vec())?;
          let sr = Array1::<i64>::from(vec![16000i64]);
          let h = Array3::<f32>::from_shape_vec([2, 1, 64], self.h.clone())?;
          let c = Array3::<f32>::from_shape_vec([2, 1, 64], self.c.clone())?;

          let outputs = self.session.run(ort::inputs![
              "input" => input.view(),
              "sr"    => sr.view(),
              "h"     => h.view(),
              "c"     => c.view(),
          ]?)?;

          let prob = outputs["output"]
              .try_extract_tensor::<f32>()?
              .view()
              .iter()
              .copied()
              .next()
              .unwrap_or(0.0)
              .clamp(0.0, 1.0);

          self.h = outputs["hn"]
              .try_extract_tensor::<f32>()?
              .view()
              .iter()
              .copied()
              .collect();
          self.c = outputs["cn"]
              .try_extract_tensor::<f32>()?
              .view()
              .iter()
              .copied()
              .collect();

          Ok(prob)
      }

      pub fn reset(&mut self) {
          self.h.fill(0.0);
          self.c.fill(0.0);
      }
  }

  #[cfg(test)]
  mod tests {
      // ... (test code from Step 1)
  }
  ```

  Then paste the test module from Step 1 at the bottom (replacing the placeholder comment).

- [ ] **Step 4: Run tests to verify they pass**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting silero -- --nocapture
  ```

  Expected: `test_load_model` PASS, `test_silence_gives_low_probability` PASS, `test_predict_returns_valid_range` PASS, `test_reset_clears_state` PASS.

  If `ort::inputs!` macro has a different API in the installed version, check the ort crate docs and adjust the input-passing syntax accordingly. The structure (input names and array shapes) remains the same.

- [ ] **Step 5: Commit**

  ```
  git add src-tauri/src/audio/silero.rs
  git commit -m "feat(audio): SileroVad wrapper with ONNX Runtime"
  ```

---

## Task 3: Make resample_linear accessible

**Files:**
- Modify: `src-tauri/src/audio/resample.rs:64`

`SmartChunker` needs to resample system audio (48 kHz) to 16 kHz before passing it to Silero. The existing `resample_linear` is private. This task makes it available inside the crate.

- [ ] **Step 1: Write a failing test in chunker.rs that calls resample_linear**

  At the bottom of `src-tauri/src/audio/chunker.rs`, add inside the `#[cfg(test)]` block:

  ```rust
  #[test]
  fn test_resample_linear_visible() {
      use crate::audio::resample::resample_linear;
      let samples = vec![0.5f32; 480]; // 10 ms @ 48 kHz
      let out = resample_linear(&samples, 48000, 16000);
      assert!(!out.is_empty());
  }
  ```

- [ ] **Step 2: Run to confirm it fails**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting test_resample_linear_visible
  ```

  Expected: error — `resample_linear` is private.

- [ ] **Step 3: Change visibility in resample.rs**

  In `src-tauri/src/audio/resample.rs`, line 64, change:
  ```rust
  fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
  ```
  to:
  ```rust
  pub(crate) fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
  ```

- [ ] **Step 4: Run test to confirm it passes**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting test_resample_linear_visible
  ```

  Expected: PASS.

- [ ] **Step 5: Remove the helper test (it was only for verifying visibility)**

  Delete the `test_resample_linear_visible` test from `chunker.rs`.

- [ ] **Step 6: Commit**

  ```
  git add src-tauri/src/audio/resample.rs src-tauri/src/audio/chunker.rs
  git commit -m "refactor(audio): make resample_linear pub(crate)"
  ```

---

## Task 4: CalibrationResult + SmartChunker upgrade

**Files:**
- Modify: `src-tauri/src/audio/chunker.rs`

This task adds:
- `CalibrationState` (private) — accumulates RMS per Silero-classified frame during the first 2 s
- `CalibrationResult` (public) — `noise_floor`, `speech_floor`, `threshold`
- `silero: Option<SileroVad>` field on `SmartChunker`
- `with_silero(silero, min_threshold) -> Self` builder method
- `take_calibration_result(&mut self) -> Option<CalibrationResult>` getter
- Updated `push()` to use Silero when present and suppress chunk emission during calibration

- [ ] **Step 1: Write failing tests for calibration and Silero fallback**

  Add these tests inside the `#[cfg(test)]` block of `chunker.rs` (after the existing tests):

  ```rust
  #[test]
  fn test_chunker_fallback_without_silero() {
      // SmartChunker without Silero should behave identically to before
      let mut chunker = SmartChunker::new(
          ChunkerConfig { min_chunk_secs: 0.1, max_chunk_secs: 0.5, silence_break_secs: 0.1, vad_sensitivity: 0.5 },
          16000, 1,
      );
      let mut speech = Vec::new();
      for i in 0..8000 {
          let t = i as f32 / 16000.0;
          speech.push((440.0_f32 * t * 2.0 * std::f32::consts::PI).sin() * 0.5);
      }
      let chunk = chunker.push(&speech);
      assert!(chunk.is_some(), "Should chunk without Silero");
  }

  #[test]
  fn test_calibration_result_is_none_without_silero() {
      let mut chunker = SmartChunker::new(ChunkerConfig::default(), 16000, 1);
      let samples = vec![0.0f32; 1600];
      chunker.push(&samples);
      assert!(chunker.take_calibration_result().is_none());
  }
  ```

- [ ] **Step 2: Run to confirm they fail**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting test_chunker_fallback_without_silero test_calibration_result_is_none_without_silero
  ```

  Expected: compilation error — `take_calibration_result` not defined.

- [ ] **Step 3: Add CalibrationState and CalibrationResult structs**

  At the top of `chunker.rs`, after the existing `use` statement, add:

  ```rust
  use super::silero::SileroVad;
  use crate::audio::resample::resample_linear;

  /// Result of the 2-second startup calibration.
  #[derive(Debug, Clone, serde::Serialize)]
  pub struct CalibrationResult {
      pub noise_floor: f32,
      pub speech_floor: f32,
      pub threshold: f32,
  }

  struct CalibrationState {
      samples_target: usize, // sample_rate * 2
      samples_seen: usize,
      voice_rms: Vec<f32>,
      noise_rms: Vec<f32>,
      min_threshold: f32,
  }

  impl CalibrationState {
      fn new(sample_rate: u32, min_threshold: f32) -> Self {
          Self {
              samples_target: sample_rate as usize * 2,
              samples_seen: 0,
              voice_rms: Vec::new(),
              noise_rms: Vec::new(),
              min_threshold,
          }
      }

      fn is_done(&self) -> bool {
          self.samples_seen >= self.samples_target
      }

      fn observe(&mut self, rms: f32, is_speech: bool) {
          if is_speech {
              self.voice_rms.push(rms);
          } else {
              self.noise_rms.push(rms);
          }
      }

      fn finish(&self) -> CalibrationResult {
          let mean = |v: &[f32]| -> f32 {
              if v.is_empty() { 0.0 } else { v.iter().sum::<f32>() / v.len() as f32 }
          };
          let noise_floor = mean(&self.noise_rms);
          let speech_floor = mean(&self.voice_rms);
          let threshold = (noise_floor * 2.5).max(self.min_threshold);
          CalibrationResult { noise_floor, speech_floor, threshold }
      }
  }
  ```

- [ ] **Step 4: Update SmartChunker struct to include new fields**

  Replace the `SmartChunker` struct (currently ends around line 56) with:

  ```rust
  pub struct SmartChunker {
      config: ChunkerConfig,
      vad: VoiceActivityDetector,
      silero: Option<SileroVad>,
      buffer: Vec<f32>,
      sample_rate: u32,
      channels: u16,
      silence_samples: usize,
      max_voice_prob: f32,
      has_speech: bool,
      calibration: Option<CalibrationState>,
      calibration_result: Option<CalibrationResult>,
  }
  ```

- [ ] **Step 5: Update SmartChunker::new() to initialize new fields**

  Replace the `new()` method body:

  ```rust
  pub fn new(config: ChunkerConfig, sample_rate: u32, channels: u16) -> Self {
      Self {
          vad: VoiceActivityDetector::with_sensitivity(config.vad_sensitivity),
          buffer: Vec::with_capacity(sample_rate as usize * 30),
          config,
          sample_rate,
          channels,
          silence_samples: 0,
          max_voice_prob: 0.0,
          has_speech: false,
          silero: None,
          calibration: None,
          calibration_result: None,
      }
  }
  ```

- [ ] **Step 6: Add with_silero() builder and take_calibration_result()**

  Add these methods after `with_default_config()`:

  ```rust
  /// Attach a Silero VAD and enable 2-second calibration.
  /// `min_threshold`: lower bound for the calibrated RMS silence threshold
  /// (typically `settings.mic_silence_threshold`).
  pub fn with_silero(mut self, silero: SileroVad, min_threshold: f32) -> Self {
      self.calibration = Some(CalibrationState::new(self.sample_rate, min_threshold));
      self.silero = Some(silero);
      self
  }

  /// Consume the calibration result produced after 2 s of audio, if ready.
  /// Returns `Some` exactly once after calibration completes.
  pub fn take_calibration_result(&mut self) -> Option<CalibrationResult> {
      self.calibration_result.take()
  }
  ```

- [ ] **Step 7: Update push() to use Silero and handle calibration**

  Replace the `push()` method:

  ```rust
  pub fn push(&mut self, samples: &[f32]) -> Option<SpeechChunk> {
      // ── Voice detection ──────────────────────────────────────────────────
      let voice_prob = if let Some(ref mut silero) = self.silero {
          let samples_16k = if self.sample_rate != 16_000 {
              resample_linear(samples, self.sample_rate, 16_000)
          } else {
              samples.to_vec()
          };
          silero.predict(&samples_16k)
      } else {
          self.vad.detect(samples)
      };

      // ── Calibration (first 2 s when Silero is present) ───────────────────
      if let Some(ref mut cal) = self.calibration {
          if !cal.is_done() {
              let rms = compute_rms_chunker(samples);
              cal.observe(rms, voice_prob > 0.5);
              cal.samples_seen += samples.len();
              // Still accumulate in buffer so no audio is lost
              self.buffer.extend(samples);

              if cal.is_done() {
                  // Store result; caller retrieves via take_calibration_result()
                  self.calibration_result = Some(cal.finish());
              }
              // Suppress chunk emission during calibration window
              return None;
          }
      }

      // ── Normal chunker logic (unchanged) ─────────────────────────────────
      self.max_voice_prob = self.max_voice_prob.max(voice_prob);

      if voice_prob > 0.3 {
          self.has_speech = true;
          self.silence_samples = 0;
      } else {
          self.silence_samples += samples.len();
      }

      self.buffer.extend(samples);

      if self.should_produce_chunk() {
          self.produce_chunk()
      } else {
          None
      }
  }
  ```

- [ ] **Step 8: Add compute_rms_chunker helper (private, avoids dependency on audio/mod.rs)**

  Add at the bottom of `chunker.rs` before the `#[cfg(test)]` block:

  ```rust
  fn compute_rms_chunker(samples: &[f32]) -> f32 {
      if samples.is_empty() { return 0.0; }
      (samples.iter().map(|&s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
  }
  ```

- [ ] **Step 9: Update reset() to not wipe calibration state**

  The `reset()` method is called after each chunk is produced. It should NOT reset Silero's internal RNN state (we want continuity between chunks) and should not clear `calibration`:

  ```rust
  fn reset(&mut self) {
      self.silence_samples = 0;
      self.max_voice_prob = 0.0;
      self.has_speech = false;
      self.vad.reset(); // fallback VAD still resets per-chunk
      // silero state persists across chunks intentionally
  }
  ```

- [ ] **Step 10: Run tests to verify**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting chunker -- --nocapture
  ```

  Expected: all chunker tests PASS (including the two new ones and all existing ones).

- [ ] **Step 11: Commit**

  ```
  git add src-tauri/src/audio/chunker.rs
  git commit -m "feat(audio): SmartChunker integrates Silero VAD + 2s calibration"
  ```

---

## Task 5: AudioCaptureState + mod.rs wiring

**Files:**
- Modify: `src-tauri/src/audio/mod.rs`

This task:
- Declares the `silero` submodule
- Adds `calibration_result: Mutex<Option<CalibrationResult>>` to `AudioCaptureState`
- Passes `silero_model_path: Option<PathBuf>` via `MicConfig` into the mic thread
- In the mic thread: creates `SileroVad`, calls `with_silero()` on the chunker, and after each `push()` checks `take_calibration_result()` to store it in `AudioCaptureState`

- [ ] **Step 1: Declare silero module and add imports**

  At the top of `audio/mod.rs`, after `pub mod vad;` (currently ~line 17), add:

  ```rust
  pub mod silero;
  ```

  Add to the `pub use` block:
  ```rust
  pub use chunker::CalibrationResult;
  pub use silero::SileroVad;
  ```

- [ ] **Step 2: Add silero_model_path to MicConfig**

  In the `MicConfig` struct (currently ~line 281), add one field:

  ```rust
  pub struct MicConfig {
      pub enabled: bool,
      pub device_id: String,
      pub silence_threshold: f32,
      pub auto_gain: bool,
      pub gain_max: f32,
      /// Path to silero_vad.onnx; None = skip Silero, use legacy VAD
      pub silero_model_path: Option<std::path::PathBuf>,
  }
  ```

- [ ] **Step 3: Add calibration_result to AudioCaptureState**

  In `AudioCaptureState` struct (currently ~line 126), add:

  ```rust
  pub struct AudioCaptureState {
      pub is_capturing: AtomicBool,
      pub current_level: parking_lot::Mutex<f32>,
      pub mic_level: parking_lot::Mutex<f32>,
      pub mic_muted: AtomicBool,
      pub is_paused: AtomicBool,
      /// Set by the mic thread when 2-second calibration completes.
      pub calibration_result: parking_lot::Mutex<Option<CalibrationResult>>,
  }
  ```

  Update `AudioCaptureState::new()`:

  ```rust
  pub fn new() -> Self {
      Self {
          is_capturing: AtomicBool::new(false),
          current_level: parking_lot::Mutex::new(0.0),
          mic_level: parking_lot::Mutex::new(0.0),
          mic_muted: AtomicBool::new(false),
          is_paused: AtomicBool::new(false),
          calibration_result: parking_lot::Mutex::new(None),
      }
  }
  ```

- [ ] **Step 4: Wire Silero into the mic thread in start_capture()**

  In the `#[cfg(target_os = "windows")]` impl of `start_capture()`, inside the mic thread spawn closure (after `let mic_gain_max = mic_config.gain_max;` capture, currently ~line 375), also capture the model path:

  ```rust
  let mic_silero_path = mic_config.silero_model_path.clone();
  ```

  Then, where the mic chunker is constructed (currently `let mut mic_chunker = chunker::SmartChunker::new(...)`), replace with:

  ```rust
  let silero_opt = mic_silero_path
      .as_deref()
      .and_then(|p| silero::SileroVad::load(p).ok());

  let base_chunker = chunker::SmartChunker::new(mic_chunker_config, mic_sr, mic_ch);
  let mut mic_chunker = if let Some(silero) = silero_opt {
      log::info!("Mic: Silero VAD ativado (2s calibração)");
      base_chunker.with_silero(silero, mic_silence)
  } else {
      log::info!("Mic: usando VAD legado (Silero indisponível)");
      base_chunker
  };
  ```

- [ ] **Step 5: Store calibration result in AudioCaptureState**

  Inside the mic capture loop (after `if let Some(speech_chunk) = mic_chunker.push(&samples)`), just before the `if state_mic.is_mic_muted()` block, add:

  ```rust
  // Store calibration result once; commands.rs will emit the event
  if let Some(cal) = mic_chunker.take_calibration_result() {
      log::info!(
          "Calibração concluída: noise_floor={:.4}, speech_floor={:.4}, threshold={:.4}",
          cal.noise_floor, cal.speech_floor, cal.threshold
      );
      *state_mic.calibration_result.lock() = Some(cal);
  }
  ```

- [ ] **Step 6: Update all other MicConfig call sites to include the new field**

  In `commands.rs`, every `audio::MicConfig { ... }` literal needs `silero_model_path: None` added (there are ~5 occurrences: `test_microphone`, `measure_ambient_noise`, `record_calibration_phase`, `test_mic_transcription_phrase`, `test_mic_with_transcription`).

  For `start_capture` command only, use `Some(...)`. For all test commands, use `None`.

  Search for all occurrences:
  ```
  grep -n "MicConfig {" src-tauri/src/commands.rs
  ```

  Then for each occurrence, add `silero_model_path: None,` as the last field.

- [ ] **Step 7: Build to verify no compilation errors**

  ```
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: compiles successfully.

- [ ] **Step 8: Commit**

  ```
  git add src-tauri/src/audio/mod.rs
  git commit -m "feat(audio): wire Silero into mic pipeline; store calibration in AudioCaptureState"
  ```

---

## Task 6: calibration-done event + MicConfig silero path in start_capture

**Files:**
- Modify: `src-tauri/src/commands.rs`

Two changes in this task:
1. In `start_capture`, resolve the resource path and pass it in `MicConfig`
2. In the audio-level polling task (which has `AppHandle`), check for `calibration_result` and emit `calibration-done`

- [ ] **Step 1: Resolve silero model path in start_capture()**

  In `commands.rs`, inside `start_capture()`, after `let settings = storage::load_settings()...` (currently ~line 171), add:

  ```rust
  // Resolve silero model path from Tauri resources
  let silero_path: Option<std::path::PathBuf> = app
      .path()
      .resource_dir()
      .ok()
      .map(|p| p.join("silero_vad.onnx"))
      .filter(|p| p.exists());
  ```

  Then in the `MicConfig` literal for `start_capture` (currently ~line 215), add the field:

  ```rust
  let mic_config = audio::MicConfig {
      enabled: settings.capture_microphone,
      device_id: settings.selected_microphone.clone(),
      silence_threshold: settings.mic_silence_threshold,
      auto_gain: settings.mic_auto_gain,
      gain_max: settings.mic_gain_max,
      silero_model_path: silero_path,
  };
  ```

- [ ] **Step 2: Emit calibration-done from the level polling task**

  In `start_capture()`, inside the `tokio::spawn(async move { ... })` for the audio level task (currently ~line 634), replace the existing body with:

  ```rust
  tokio::spawn(async move {
      while cap_level.is_capturing() {
          let level = *cap_level.current_level.lock();
          let mic   = *cap_level.mic_level.lock();
          let _ = app_level.emit("audio-level", level);
          let _ = app_level.emit("mic-level", mic);

          // Emit calibration-done once when the mic thread finishes calibration
          if let Some(cal) = cap_level.calibration_result.lock().take() {
              let _ = app_level.emit("calibration-done", serde_json::json!({
                  "noise_floor": cal.noise_floor,
                  "speech_floor": cal.speech_floor,
                  "threshold": cal.threshold,
              }));
              log::info!(
                  "Evento calibration-done emitido (threshold={:.4})",
                  cal.threshold
              );
          }

          tokio::time::sleep(std::time::Duration::from_millis(50)).await;
      }
  });
  ```

- [ ] **Step 3: Add `use tauri::Manager;` if not already imported**

  Check line 1–20 of `commands.rs` — `use tauri::{AppHandle, Emitter, Manager, State};` should already include `Manager`. If not, add it.

- [ ] **Step 4: Build and run to verify**

  ```
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: compiles. Then start the app, begin a recording, and check the logs for `Calibração concluída:` and `Evento calibration-done emitido`.

- [ ] **Step 5: Commit**

  ```
  git add src-tauri/src/commands.rs
  git commit -m "feat(transcription): emit calibration-done event after 2s mic calibration"
  ```

---

## Task 7: last_sentence_context helper

**Files:**
- Modify: `src-tauri/src/commands.rs`

Replace the 120-word rolling context with the last complete sentence.

- [ ] **Step 1: Write the failing unit tests**

  Add a test module at the bottom of `commands.rs` (before the final `}`):

  ```rust
  #[cfg(test)]
  mod tests {
      use super::last_sentence_context;

      #[test]
      fn test_empty_transcript() {
          assert_eq!(last_sentence_context(""), "");
      }

      #[test]
      fn test_transcript_with_period() {
          let t = "Hello world. Goodbye there.";
          assert_eq!(last_sentence_context(t), "Goodbye there.");
      }

      #[test]
      fn test_transcript_no_period() {
          // No sentence terminator — return whole text (capped at 120 words)
          let t = "Hello world goodbye";
          assert_eq!(last_sentence_context(t), "Hello world goodbye");
      }

      #[test]
      fn test_only_punctuation() {
          let t = "...";
          // Finds last '.', sentence between it and prev '.' is "." — trim gives "."
          // Not empty, so returns "."
          let result = last_sentence_context(t);
          assert!(!result.is_empty());
      }

      #[test]
      fn test_exclamation_and_question() {
          let t = "Really? Of course! Let's do it.";
          assert_eq!(last_sentence_context(t), "Let's do it.");
      }

      #[test]
      fn test_very_long_sentence_capped_at_120_words() {
          let long: String = (0..150).map(|i| format!("word{} ", i)).collect();
          let result = last_sentence_context(long.trim());
          let count = result.split_whitespace().count();
          assert!(count <= 120, "Expected ≤ 120 words, got {}", count);
      }
  }
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting tests::test_empty_transcript -- --nocapture
  ```

  Expected: error — `last_sentence_context` not defined.

- [ ] **Step 3: Add the helper function**

  Add this function after `matches_hallucination_pattern()` (currently ~line 62):

  ```rust
  /// Returns the last complete sentence from `transcript` as context for Whisper's prompt.
  /// If no sentence terminator (`.`, `!`, `?`) is found, returns up to the last 120 words.
  /// Always caps at 120 words to bound prompt length.
  fn last_sentence_context(transcript: &str) -> String {
      let trimmed = transcript.trim();
      if trimmed.is_empty() {
          return String::new();
      }

      const SENTENCE_ENDS: [char; 3] = ['.', '!', '?'];
      const MAX_WORDS: usize = 120;

      // Find last sentence terminator
      let last_term = trimmed.char_indices().rev().find(|(_, c)| SENTENCE_ENDS.contains(c));

      let effective: &str = match last_term {
          None => trimmed,
          Some((end_pos, end_char)) => {
              let before = &trimmed[..end_pos];
              let prev_term = before
                  .char_indices()
                  .rev()
                  .find(|(_, c)| SENTENCE_ENDS.contains(c));
              let start = match prev_term {
                  None => 0,
                  Some((i, c)) => i + c.len_utf8(),
              };
              let slice = &trimmed[start..end_pos + end_char.len_utf8()];
              slice.trim()
          }
      };

      let words: Vec<&str> = effective.split_whitespace().collect();
      let start = words.len().saturating_sub(MAX_WORDS);
      words[start..].join(" ")
  }
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml -p jgp-meeting tests:: -- --nocapture
  ```

  Expected: all 6 tests PASS.

- [ ] **Step 5: Replace the 120-word context block in process_chunk**

  In `process_chunk` (currently ~line 289–295), replace:

  ```rust
  let context_words: String = {
      let words: Vec<&str> = accumulated.split_whitespace().collect();
      let start = words.len().saturating_sub(120);
      words[start..].join(" ")
  };
  ```

  with:

  ```rust
  let context_words = last_sentence_context(&accumulated);
  ```

- [ ] **Step 6: Build to verify**

  ```
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: compiles with no errors.

- [ ] **Step 7: Commit**

  ```
  git add src-tauri/src/commands.rs
  git commit -m "feat(transcription): prompt context = last complete sentence"
  ```

---

## Task 8: Parallel drain with JoinSet

**Files:**
- Modify: `src-tauri/src/commands.rs`

Replace the sequential drain loop (Fase 3) with a parallel `tokio::task::JoinSet`. Each chunk spawns its own task. `process_chunk`'s insertion already uses `partition_point` for order, so out-of-order completion is safe.

- [ ] **Step 1: Write a test for drain ordering**

  This is a manual integration test — add a doc-comment test in the form of a `#[tokio::test]` placeholder that describes the expectation (actual parallel drain with mock is complex; we'll verify manually):

  Add inside the `#[cfg(test)] mod tests` block in `commands.rs`:

  ```rust
  #[test]
  fn test_drain_parallel_note() {
      // Parallel drain correctness is verified manually:
      // 1. process_chunk inserts segments via partition_point(timestamp)
      // 2. JoinSet tasks complete in any order but segments are always ordered
      // 3. Final transcript is identical to sequential drain for same chunks
      // Run the app, record, stop, verify transcript order in logs.
      assert!(true); // placeholder — real verification is manual
  }
  ```

- [ ] **Step 2: Locate Phase 3 in start_capture() worker**

  The drain loop starts at approximately line 570:
  ```rust
  for (i, drain_chunk) in pre_drain.into_iter().enumerate() {
  ```

  Replace this entire `for` loop (from `for (i, drain_chunk)` to the end of the inner `emit` call) with:

  ```rust
  let mut join_set = tokio::task::JoinSet::new();
  let pre_drain_len = pre_drain.len();

  for drain_chunk in pre_drain.into_iter() {
      let app3       = app_clone.clone();
      let provider3  = provider_str.clone();
      let lang3      = language.clone();
      let key3       = api_key.clone();
      let groq3      = groq_key.clone();
      let prompt3    = whisper_prompt.clone();
      let glossary3  = whisper_glossary.clone();
      let recv_ms    = recording_start.elapsed().as_millis() as u64;

      join_set.spawn(async move {
          process_chunk(
              drain_chunk, recording_start, recv_ms,
              &provider3, &lang3, &key3, &groq3, &prompt3, &glossary3, &app3,
          ).await
      });
  }

  let mut completed = 0usize;
  while let Some(_result) = join_set.join_next().await {
      completed += 1;
      let remaining = pre_drain_len - completed;
      let _ = app_clone.emit("transcription-draining", serde_json::json!({
          "pending": remaining,
          "total": pre_drain_len,
          "meeting_id": drain_meeting_id,
      }));
      log::info!("Drain: {}/{} concluídos", completed, pre_drain_len);
  }
  ```

  The `if !pre_drain.is_empty()` guard and the initial emit before the loop remain unchanged.

- [ ] **Step 3: Build to verify**

  ```
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: compiles with no errors.

- [ ] **Step 4: Manually test drain ordering**

  Start the app, record ~30 seconds of speech, stop. Observe:
  - `transcription-draining` events arrive with decreasing `pending` counts
  - Final transcript order is correct (chronological)
  - No panics or deadlocks in console

- [ ] **Step 5: Run all tests**

  ```
  cargo test --manifest-path src-tauri/Cargo.toml
  ```

  Expected: all tests PASS.

- [ ] **Step 6: Commit**

  ```
  git add src-tauri/src/commands.rs
  git commit -m "feat(transcription): parallel drain with JoinSet"
  ```

---

## Post-implementation checklist

- [ ] `cargo test` — all tests pass
- [ ] `cargo build --release` — builds without warnings
- [ ] Manual: record 5+ seconds, observe `Calibração concluída` in logs
- [ ] Manual: `calibration-done` event received in browser devtools (Network > WS or Tauri event inspector)
- [ ] Manual: transcript after stop is correctly ordered
- [ ] Manual: logs show `Silero VAD ativado` for mic thread OR `usando VAD legado` as graceful fallback
