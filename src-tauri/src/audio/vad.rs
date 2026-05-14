/// audio/vad.rs
/// Voice Activity Detection - Detecta presença de fala em segmentos de áudio.
/// Implementa detecção baseada em energia e zero-crossing rate (sem dependências externas pesadas).
/// Alternativa simples ao WebRTC VAD ou Silero VAD.

/// Configuração do detector VAD
#[derive(Debug, Clone)]
pub struct VadConfig {
    /// Sensibilidade (0.0 - 1.0). Menor = mais sensível.
    pub sensitivity: f32,
    /// Duração mínima de fala para considerar como voz (em samples)
    pub min_speech_samples: usize,
    /// Duração de silêncio para finalizar segmento de fala (em samples)
    pub silence_pad_samples: usize,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sensitivity: 0.5,
            min_speech_samples: 800,   // ~50ms @ 16kHz
            silence_pad_samples: 2400, // ~150ms @ 16kHz
        }
    }
}

/// Voice Activity Detector - Detecta segmentos de fala em áudio.
pub struct VoiceActivityDetector {
    config: VadConfig,
    /// Histórico de energia para normalização adaptativa
    energy_history: Vec<f32>,
    history_size: usize,
    /// Contador de samples de fala consecutivos
    speech_counter: usize,
    /// Contador de samples de silêncio após fala
    silence_counter: usize,
    /// Estado atual
    is_in_speech: bool,
    /// Threshold adaptativo de energia
    adaptive_threshold: f32,
}

impl VoiceActivityDetector {
    pub fn new(config: VadConfig) -> Self {
        Self {
            history_size: 20,
            energy_history: Vec::with_capacity(20),
            speech_counter: 0,
            silence_counter: 0,
            is_in_speech: false,
            adaptive_threshold: 0.01,
            config,
        }
    }

    pub fn with_sensitivity(sensitivity: f32) -> Self {
        let mut config = VadConfig::default();
        config.sensitivity = sensitivity.clamp(0.0, 1.0);
        Self::new(config)
    }

    /// Analisa um frame de áudio e retorna probabilidade de fala (0.0 - 1.0)
    /// Baseado em: energia RMS + zero-crossing rate + spectral centroid simplificado
    pub fn detect(&mut self, samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }

        // Calcula métricas
        let rms = compute_rms(samples);
        let zcr = compute_zero_crossing_rate(samples);
        let spectral_flatness = compute_spectral_flatness_approx(samples);

        // Atualiza threshold adaptativo
        self.update_adaptive_threshold(rms);

        // Score combinado (0.0 - 1.0)
        let energy_score = if self.adaptive_threshold > 0.0 {
            (rms / self.adaptive_threshold).min(1.0)
        } else {
            0.0
        };

        // Fala tende a ter ZCR moderado (0.1 - 0.3)
        // Ruído branco tem ZCR alto (> 0.4)
        // Silêncio tem ZCR baixo (< 0.1)
        let zcr_score = if zcr > 0.05 && zcr < 0.45 {
            1.0 - (zcr - 0.25).abs() * 3.0
        } else {
            0.0
        };

        // Fala tem spectral flatness baixo (harmônicos)
        // Ruído tem spectral flatness alto
        let spectral_score = 1.0 - spectral_flatness;

        // Combina scores com pesos
        let combined_score = energy_score * 0.5 + zcr_score * 0.25 + spectral_score * 0.25;

        // Aplica sensibilidade (inversamente proporcional)
        let threshold = 0.3 + self.config.sensitivity * 0.4;
        let is_speech = combined_score > threshold;

        // Atualiza estado
        if is_speech {
            self.speech_counter += samples.len();
            self.silence_counter = 0;
            if self.speech_counter >= self.config.min_speech_samples {
                self.is_in_speech = true;
            }
        } else {
            self.silence_counter += samples.len();
            if self.silence_counter > self.config.silence_pad_samples {
                self.is_in_speech = false;
                self.speech_counter = 0;
            }
        }

        combined_score
    }

    /// Retorna true se está atualmente em um segmento de fala
    pub fn is_speech(&self) -> bool {
        self.is_in_speech
    }

    /// Retorna true se detectou uma pausa natural (silêncio após fala)
    pub fn has_natural_break(&self) -> bool {
        self.silence_counter > self.config.silence_pad_samples
            && self.speech_counter > self.config.min_speech_samples
    }

    /// Reseta o estado do detector
    pub fn reset(&mut self) {
        self.speech_counter = 0;
        self.silence_counter = 0;
        self.is_in_speech = false;
        self.energy_history.clear();
    }

    fn update_adaptive_threshold(&mut self, energy: f32) {
        self.energy_history.push(energy);
        if self.energy_history.len() > self.history_size {
            self.energy_history.remove(0);
        }

        // Threshold = média das energias * fator de sensibilidade
        if !self.energy_history.is_empty() {
            let sum: f32 = self.energy_history.iter().sum();
            let mean = sum / self.energy_history.len() as f32;
            // Fator multiplicador baseado na sensibilidade
            let factor = 1.5 + self.config.sensitivity * 2.0;
            self.adaptive_threshold = mean * factor;
            // Garante mínimo
            self.adaptive_threshold = self.adaptive_threshold.max(0.005);
        }
    }
}

/// Calcula RMS (Root Mean Square) - energia do sinal
fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|&s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Calcula Zero-Crossing Rate - taxa de cruzamentos por zero
fn compute_zero_crossing_rate(samples: &[f32]) -> f32 {
    if samples.len() < 2 {
        return 0.0;
    }
    let mut crossings = 0;
    for i in 1..samples.len() {
        if (samples[i] >= 0.0) != (samples[i - 1] >= 0.0) {
            crossings += 1;
        }
    }
    crossings as f32 / (samples.len() - 1) as f32
}

/// Aproximação de Spectral Flatness - razão entre média geométrica e aritmética
/// Valores altos indicam ruído, valores baixos indicam tons/harmônicos
fn compute_spectral_flatness_approx(samples: &[f32]) -> f32 {
    if samples.len() < 64 {
        return 0.5;
    }

    // Usa diferenças como aproximação de "spectral content"
    // Isso é uma simplificação - evita FFT completa
    let frame_size = 64;
    let n_frames = samples.len() / frame_size;

    if n_frames == 0 {
        return 0.5;
    }

    let mut flatness_sum = 0.0;
    for i in 0..n_frames {
        let start = i * frame_size;
        let end = (start + frame_size).min(samples.len());
        let frame = &samples[start..end];

        // Calcula variância local como proxy de spectral content
        let mean: f32 = frame.iter().sum::<f32>() / frame.len() as f32;
        let variance: f32 =
            frame.iter().map(|&x| (x - mean).powi(2)).sum::<f32>() / frame.len() as f32;

        // Normaliza para 0-1
        flatness_sum += 1.0 / (1.0 + variance * 100.0);
    }

    flatness_sum / n_frames as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vad_silence() {
        let mut vad = VoiceActivityDetector::new(VadConfig::default());
        let silence: Vec<f32> = vec![0.0; 1600];
        let score = vad.detect(&silence);
        assert!(score < 0.3, "Silêncio deve ter score baixo: {}", score);
    }

    #[test]
    fn test_vad_speech() {
        let mut vad = VoiceActivityDetector::new(VadConfig::default());
        // Simula fala com ruído
        let mut speech = Vec::with_capacity(1600);
        for i in 0..1600 {
            let t = i as f32 / 16000.0;
            // Combina frequências típicas de fala
            speech.push((440.0 * t * 2.0 * std::f32::consts::PI).sin() * 0.3 * (100.0 * t).sin());
        }
        let score = vad.detect(&speech);
        assert!(score > 0.2, "Fala deve ter score maior: {}", score);
    }
}
