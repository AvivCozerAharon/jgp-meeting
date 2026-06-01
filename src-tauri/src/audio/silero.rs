/// audio/silero.rs — Silero VAD v4 wrapper
///
/// Wraps an ONNX Runtime session to run Silero VAD v4 inference.
/// Processes audio in 512-sample frames at 16 kHz and maintains LSTM hidden state.

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn model_path() -> std::path::PathBuf {
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

use std::path::Path;
use anyhow::Result;
use ort::session::Session;
use ort::value::Tensor;

const CHUNK_SIZE: usize = 512; // 32 ms @ 16 kHz — required by Silero v4
const H_SIZE: usize = 128;     // 2 × 1 × 64 flattened

pub struct SileroVad {
    session: Session,
    h: Vec<f32>,
    c: Vec<f32>,
}

impl SileroVad {
    pub fn load(model_path: &Path) -> Result<Self> {
        // With load-dynamic feature, ort must know where onnxruntime.dll is.
        // Look for it next to the model file (same resources/ directory).
        if let Some(dir) = model_path.parent() {
            let dll = dir.join("onnxruntime.dll");
            if dll.exists() {
                // SAFETY: called once before any ORT session; no other threads use ORT yet.
                #[allow(deprecated)]
                unsafe { std::env::set_var("ORT_DYLIB_PATH", &dll) };
            }
        }

        let session = Session::builder()?
            .commit_from_file(model_path)?;
        Ok(Self {
            session,
            h: vec![0.0f32; H_SIZE],
            c: vec![0.0f32; H_SIZE],
        })
    }

    /// Expects mono 16 kHz samples; best accuracy with multiples of 512 (32 ms frames).
    pub fn predict(&mut self, samples: &[f32]) -> f32 {
        if samples.is_empty() { return 0.0; }
        let mut total = 0.0f32;
        let mut count = 0usize;
        for chunk in samples.chunks(CHUNK_SIZE) {
            let mut frame = chunk.to_vec();
            frame.resize(CHUNK_SIZE, 0.0);
            match self.run_frame(&frame) {
                Ok(p) => { total += p; count += 1; }
                Err(e) => log::warn!("SileroVad: frame inference failed: {e}"),
            }
        }
        if count == 0 { 0.0 } else { total / count as f32 }
    }

    fn run_frame(&mut self, frame: &[f32]) -> Result<f32> {
        // Build tensors using (shape, Vec<T>) form — avoids ndarray version mismatch
        let input_tensor = Tensor::<f32>::from_array(([1usize, CHUNK_SIZE], frame.to_vec()))?;
        let sr_tensor    = Tensor::<i64>::from_array(([1usize], vec![16000i64]))?;
        let h_tensor     = Tensor::<f32>::from_array(([2usize, 1, 64], self.h.clone()))?;
        let c_tensor     = Tensor::<f32>::from_array(([2usize, 1, 64], self.c.clone()))?;

        let outputs = self.session.run(ort::inputs![
            "input" => input_tensor,
            "sr"    => sr_tensor,
            "h"     => h_tensor,
            "c"     => c_tensor,
        ])?;

        let (_, output_data) = outputs["output"].try_extract_tensor::<f32>()?;
        let prob = output_data.iter().copied().next().unwrap_or(0.0).clamp(0.0, 1.0);

        let (_, hn_data) = outputs["hn"].try_extract_tensor::<f32>()?;
        self.h = hn_data.to_vec();

        let (_, cn_data) = outputs["cn"].try_extract_tensor::<f32>()?;
        self.c = cn_data.to_vec();

        Ok(prob)
    }

    pub fn reset(&mut self) {
        self.h.fill(0.0);
        self.c.fill(0.0);
    }
}
