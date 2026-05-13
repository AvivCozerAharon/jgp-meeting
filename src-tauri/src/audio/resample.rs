/// audio/resample.rs
/// Resample de alta qualidade usando Rubato (polihermítico).
/// Substitui a interpolação linear do código original.
/// Usa fallback linear para buffers pequenos.
use anyhow::Result;
use rubato::{FftFixedInOut, Resampler as RubatoResampler};

pub struct Resampler {
    resampler: FftFixedInOut<f32>,
    source_rate: u32,
    target_rate: u32,
    channels: usize,
}

impl Resampler {
    pub fn new(source_rate: u32, target_rate: u32, channels: usize) -> Result<Self> {
        let resampler =
            FftFixedInOut::new(source_rate as usize, target_rate as usize, 1024, channels)?;
        Ok(Self {
            resampler,
            source_rate,
            target_rate,
            channels,
        })
    }

    pub fn resample(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        if self.source_rate == self.target_rate {
            return Ok(samples.to_vec());
        }
        if samples.is_empty() {
            return Ok(Vec::new());
        }

        let input: Vec<Vec<f32>> = if self.channels == 1 {
            vec![samples.to_vec()]
        } else {
            let mut chs: Vec<Vec<f32>> = vec![Vec::new(); self.channels];
            for frame in samples.chunks_exact(self.channels) {
                for (i, &s) in frame.iter().enumerate() {
                    chs[i].push(s);
                }
            }
            chs
        };

        let output = self.resampler.process(&input, None)?;

        if self.channels == 1 {
            Ok(output.into_iter().next().unwrap_or_default())
        } else {
            let min_len = output.iter().map(|c| c.len()).min().unwrap_or(0);
            let mut interleaved = Vec::with_capacity(min_len * self.channels);
            for i in 0..min_len {
                for ch in &output {
                    interleaved.push(ch[i]);
                }
            }
            Ok(interleaved)
        }
    }
}

fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = source_rate as f64 / target_rate as f64;
    let out_len = ((samples.len() as f64) / ratio).ceil() as usize;
    if out_len == 0 {
        return Vec::new();
    }
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let lo = pos.floor() as usize;
            let hi = (lo + 1).min(samples.len().saturating_sub(1));
            let t = pos.fract() as f32;
            samples[lo] * (1.0 - t) + samples[hi] * t
        })
        .collect()
}

pub fn to_whisper_format(samples: &[f32], source_rate: u32, channels: u16) -> Result<Vec<f32>> {
    let mono: Vec<f32> = if channels == 1 {
        samples.to_vec()
    } else {
        let ch = channels as usize;
        samples
            .chunks_exact(ch)
            .map(|frame| frame.iter().sum::<f32>() / ch as f32)
            .collect()
    };

    const TARGET_RATE: u32 = 16_000;
    if source_rate == TARGET_RATE {
        return Ok(mono);
    }

    // Tenta Rubato para buffers grandes, fallback linear para pequenos
    if mono.len() >= 4096 {
        if let Ok(mut resampler) = Resampler::new(source_rate, TARGET_RATE, 1) {
            if let Ok(result) = resampler.resample(&mono) {
                if !result.is_empty() {
                    return Ok(result);
                }
            }
        }
        log::warn!("Rubato resample falhou, usando fallback linear");
    }

    Ok(resample_linear(&mono, source_rate, TARGET_RATE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_passthrough() {
        let mono_16k = vec![0.5f32; 1600];
        let result = to_whisper_format(&mono_16k, 16000, 1).unwrap();
        assert_eq!(result.len(), 1600);
    }

    #[test]
    fn test_stereo_to_mono() {
        let stereo = (0..1600).flat_map(|_| [0.5f32, 0.3f32]).collect::<Vec<_>>();
        let result = to_whisper_format(&stereo, 16000, 2).unwrap();
        assert_eq!(result.len(), 1600);
    }

    #[test]
    fn test_linear_fallback_small_buffer() {
        let small = vec![0.5f32; 100];
        let result = to_whisper_format(&small, 48000, 1).unwrap();
        assert!(!result.is_empty());
        assert!(result.len() < 100);
    }

    #[test]
    fn test_linear_downsample() {
        let samples = vec![0.5f32; 4800];
        let result = resample_linear(&samples, 48000, 16000);
        assert!(result.len() > 1400 && result.len() < 1800);
    }
}
