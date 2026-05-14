/// audio/agc.rs
/// Automatic Gain Control - Normaliza volume de áudio para melhorar transcrição.
/// Implementa AGC avançado com envelope follower e soft limiting.

/// Configuração do AGC
#[derive(Debug, Clone)]
pub struct AgcConfig {
    /// Pico alvo (0.0 - 1.0)
    pub target_peak: f32,
    /// Ganho máximo permitido
    pub max_gain: f32,
    /// Tempo de ataque em ms (resposta rápida a picos)
    pub attack_ms: f32,
    /// Tempo de release em ms (recuperação lenta)
    pub release_ms: f32,
    /// Ativa soft limiter para evitar clipping
    pub enable_limiter: bool,
}

impl Default for AgcConfig {
    fn default() -> Self {
        Self {
            target_peak: 0.85,
            max_gain: 6.0,
            attack_ms: 5.0,
            release_ms: 100.0,
            enable_limiter: true,
        }
    }
}

/// Automatic Gain Controller
pub struct AutomaticGainControl {
    config: AgcConfig,
    /// Ganho atual aplicado
    current_gain: f32,
    /// Envelope follower state
    envelope: f32,
    /// Sample rate para cálculos de tempo
    sample_rate: u32,
}

impl AutomaticGainControl {
    pub fn new(config: AgcConfig, sample_rate: u32) -> Self {
        Self {
            config,
            current_gain: 1.0,
            envelope: 0.0,
            sample_rate,
        }
    }

    pub fn with_default_config(sample_rate: u32) -> Self {
        Self::new(AgcConfig::default(), sample_rate)
    }

    /// Processa samples in-place aplicando ganho automático
    pub fn process(&mut self, samples: &mut [f32]) {
        if samples.is_empty() {
            return;
        }

        // Calcula coeficientes de attack/release
        let attack_coeff = self.time_constant_coeff(self.config.attack_ms);
        let release_coeff = self.time_constant_coeff(self.config.release_ms);

        // Envelope follower com attack/release
        for sample in samples.iter_mut() {
            let abs_val = sample.abs();

            // Atualiza envelope
            if abs_val > self.envelope {
                self.envelope = attack_coeff * self.envelope + (1.0 - attack_coeff) * abs_val;
            } else {
                self.envelope = release_coeff * self.envelope + (1.0 - release_coeff) * abs_val;
            }

            // Calcula ganho necessário
            if self.envelope > 1e-6 {
                let desired_gain = self.config.target_peak / self.envelope;
                let clamped_gain =
                    desired_gain.clamp(1.0 / self.config.max_gain, self.config.max_gain);

                // Suaviza transição de ganho (evita clicks)
                self.current_gain = 0.99 * self.current_gain + 0.01 * clamped_gain;
            }

            // Aplica ganho
            *sample *= self.current_gain;

            // Soft limiter (previne clipping)
            if self.config.enable_limiter {
                *sample = soft_limit(*sample);
            }
        }
    }

    /// Processa samples e retorna cópia (não modifica original)
    pub fn process_copy(&mut self, samples: &[f32]) -> Vec<f32> {
        let mut output = samples.to_vec();
        self.process(&mut output);
        output
    }

    /// Retorna o ganho atual
    pub fn current_gain(&self) -> f32 {
        self.current_gain
    }

    /// Reseta o estado do AGC
    pub fn reset(&mut self) {
        self.current_gain = 1.0;
        self.envelope = 0.0;
    }

    fn time_constant_coeff(&self, time_ms: f32) -> f32 {
        let time_samples = (time_ms / 1000.0) * self.sample_rate as f32;
        (-1.0 / time_samples).exp()
    }
}

/// Soft limiter usando tanh - evita clipping brusco
#[inline]
fn soft_limit(x: f32) -> f32 {
    // Tanh suave para evitar distorção em níveis normais
    if x.abs() < 0.8 {
        x
    } else {
        x.tanh()
    }
}

/// Normaliza áudio para pico alvo (stateless)
pub fn normalize_to_peak(samples: &mut [f32], target_peak: f32, max_gain: f32) {
    if samples.is_empty() {
        return;
    }

    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    if peak < 1e-6 {
        return;
    }

    let gain = (target_peak / peak).min(max_gain).max(1.0);
    for sample in samples.iter_mut() {
        *sample = (*sample * gain).clamp(-1.0, 1.0);
    }
}

/// RMS normalization (stateless)
pub fn normalize_to_rms(samples: &mut [f32], target_rms: f32, max_gain: f32) {
    if samples.is_empty() {
        return;
    }

    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    if rms < 1e-6 {
        return;
    }

    let gain = (target_rms / rms).min(max_gain).max(1.0);
    for sample in samples.iter_mut() {
        *sample = (*sample * gain).clamp(-1.0, 1.0);
    }
}

/// Compressor simples de dinâmica
pub struct DynamicCompressor {
    threshold: f32,
    ratio: f32,
    attack_coeff: f32,
    release_coeff: f32,
    envelope: f32,
}

impl DynamicCompressor {
    pub fn new(
        threshold: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        sample_rate: u32,
    ) -> Self {
        let attack_coeff = (-1.0 / (attack_ms / 1000.0 * sample_rate as f32)).exp();
        let release_coeff = (-1.0 / (release_ms / 1000.0 * sample_rate as f32)).exp();

        Self {
            threshold,
            ratio,
            attack_coeff,
            release_coeff,
            envelope: 0.0,
        }
    }

    pub fn process(&mut self, samples: &mut [f32]) {
        for sample in samples.iter_mut() {
            let abs_val = sample.abs();

            // Envelope follower
            if abs_val > self.envelope {
                self.envelope =
                    self.attack_coeff * self.envelope + (1.0 - self.attack_coeff) * abs_val;
            } else {
                self.envelope =
                    self.release_coeff * self.envelope + (1.0 - self.release_coeff) * abs_val;
            }

            // Compression
            if self.envelope > self.threshold {
                let db_over = 20.0 * (self.envelope / self.threshold).log10();
                let db_reduction = db_over * (1.0 - 1.0 / self.ratio);
                let gain = 10.0_f32.powf(-db_reduction / 20.0);
                *sample *= gain;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agc_normalizes_low_volume() {
        let mut agc = AutomaticGainControl::new(AgcConfig::default(), 16000);
        let mut samples = vec![0.1; 1600]; // Very quiet

        agc.process(&mut samples);

        let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(peak > 0.3, "Peak should be amplified, got {}", peak);
    }

    #[test]
    fn test_agc_doesnt_amplify_silence() {
        let mut agc = AutomaticGainControl::new(AgcConfig::default(), 16000);
        let mut samples = vec![0.0001; 1600]; // Near silence

        agc.process(&mut samples);

        // Should not blow up
        let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(peak < 1.0, "Peak should not clip, got {}", peak);
    }

    #[test]
    fn test_agc_limits_high_volume() {
        let config = AgcConfig {
            target_peak: 0.85,
            max_gain: 2.0,
            enable_limiter: true,
            ..Default::default()
        };
        let mut agc = AutomaticGainControl::new(config, 16000);
        let mut samples = vec![0.9; 1600]; // Already loud

        agc.process(&mut samples);

        // Should not clip (thanks to limiter)
        let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(peak <= 1.0, "Peak should not exceed 1.0, got {}", peak);
    }
}
