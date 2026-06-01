/// audio/chunker.rs
/// Smart Chunker - Divide áudio em segmentos de fala completos.
/// Evita cortar frases no meio, respeitando pausas naturais.
use super::vad::VoiceActivityDetector;

/// Configuração do Smart Chunker
#[derive(Debug, Clone)]
pub struct ChunkerConfig {
    /// Duração mínima de chunk em segundos
    pub min_chunk_secs: f32,
    /// Duração máxima de chunk em segundos
    pub max_chunk_secs: f32,
    /// Duração de silêncio para considerar como pausa natural (segundos)
    pub silence_break_secs: f32,
    /// Sensibilidade do VAD (0.0 - 1.0)
    pub vad_sensitivity: f32,
}

impl Default for ChunkerConfig {
    fn default() -> Self {
        Self {
            min_chunk_secs: 2.0,
            max_chunk_secs: 30.0,
            silence_break_secs: 0.5,
            vad_sensitivity: 0.5,
        }
    }
}

/// Chunk de áudio pronto para transcrição
#[derive(Debug, Clone)]
pub struct SpeechChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_secs: f32,
    pub voice_probability: f32,
}

/// Smart Chunker - Acumula áudio e produz chunks em pontos naturais de pausa
pub struct SmartChunker {
    config: ChunkerConfig,
    vad: VoiceActivityDetector,
    /// Buffer de samples acumulados
    buffer: Vec<f32>,
    /// Sample rate do áudio
    sample_rate: u32,
    /// Número de canais
    channels: u16,
    /// Contador de samples em silêncio
    silence_samples: usize,
    /// Maior probabilidade de voz no chunk atual
    max_voice_prob: f32,
    /// Flag indicando se houve fala no buffer atual
    has_speech: bool,
}

impl SmartChunker {
    pub fn new(config: ChunkerConfig, sample_rate: u32, channels: u16) -> Self {
        Self {
            vad: VoiceActivityDetector::with_sensitivity(config.vad_sensitivity),
            buffer: Vec::with_capacity(sample_rate as usize * 30), // max 30s
            config,
            sample_rate,
            channels,
            silence_samples: 0,
            max_voice_prob: 0.0,
            has_speech: false,
        }
    }

    pub fn with_default_config(sample_rate: u32, channels: u16) -> Self {
        Self::new(ChunkerConfig::default(), sample_rate, channels)
    }

    /// Adiciona samples ao buffer e retorna um chunk completo se detectar pausa natural
    /// ou se atingir o tamanho máximo.
    pub fn push(&mut self, samples: &[f32]) -> Option<SpeechChunk> {
        // Detecta voz no frame
        let voice_prob = self.vad.detect(samples);

        // Atualiza estatísticas
        self.max_voice_prob = self.max_voice_prob.max(voice_prob);

        if voice_prob > 0.3 {
            self.has_speech = true;
            self.silence_samples = 0;
        } else {
            self.silence_samples += samples.len();
        }

        // Acumula no buffer
        self.buffer.extend(samples);

        // Verifica se deve produzir um chunk
        let should_chunk = self.should_produce_chunk();

        if should_chunk {
            self.produce_chunk()
        } else {
            None
        }
    }

    /// Força a produção de um chunk com o buffer atual (usado ao final da gravação)
    pub fn flush(&mut self) -> Option<SpeechChunk> {
        if self.buffer.is_empty() || !self.has_speech {
            self.reset();
            return None;
        }

        let duration = self.buffer_duration();
        if duration < 0.3 {
            // Muito curto, descarta
            self.reset();
            return None;
        }

        let samples = std::mem::take(&mut self.buffer);
        let voice_prob = self.max_voice_prob;
        self.reset();

        Some(SpeechChunk {
            samples,
            sample_rate: self.sample_rate,
            channels: self.channels,
            duration_secs: duration,
            voice_probability: voice_prob,
        })
    }

    /// Retorna a duração atual do buffer em segundos
    pub fn buffer_duration(&self) -> f32 {
        if self.sample_rate == 0 || self.channels == 0 {
            return 0.0;
        }
        self.buffer.len() as f32 / (self.sample_rate as f32 * self.channels as f32)
    }

    /// Retorna o número de samples no buffer
    pub fn buffer_len(&self) -> usize {
        self.buffer.len()
    }

    /// Limpa o buffer e reseta o estado
    pub fn clear(&mut self) {
        self.buffer.clear();
        self.reset();
    }

    fn should_produce_chunk(&self) -> bool {
        let duration = self.buffer_duration();

        // Produz chunk se:
        // 1. Buffer atingiu tamanho máximo
        if duration >= self.config.max_chunk_secs {
            return true;
        }

        // 2. Detectou pausa natural E tem tamanho mínimo
        if duration >= self.config.min_chunk_secs {
            let silence_duration =
                self.silence_samples as f32 / (self.sample_rate as f32 * self.channels as f32);
            if silence_duration >= self.config.silence_break_secs {
                return true;
            }
        }

        false
    }

    fn produce_chunk(&mut self) -> Option<SpeechChunk> {
        if self.buffer.is_empty() || !self.has_speech {
            self.reset();
            return None;
        }

        // Remove silêncio do final do chunk
        let silence_samples_to_remove = self.silence_samples.min(self.buffer.len());
        if silence_samples_to_remove > 0 {
            self.buffer
                .truncate(self.buffer.len() - silence_samples_to_remove);
        }

        if self.buffer.is_empty() {
            self.reset();
            return None;
        }

        let samples = std::mem::take(&mut self.buffer);
        let duration = samples.len() as f32 / (self.sample_rate as f32 * self.channels as f32);
        let voice_prob = self.max_voice_prob;

        self.reset();

        Some(SpeechChunk {
            samples,
            sample_rate: self.sample_rate,
            channels: self.channels,
            duration_secs: duration,
            voice_probability: voice_prob,
        })
    }

    fn reset(&mut self) {
        self.silence_samples = 0;
        self.max_voice_prob = 0.0;
        self.has_speech = false;
        self.vad.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunker_produces_on_max_duration() {
        let mut chunker = SmartChunker::new(
            ChunkerConfig {
                min_chunk_secs: 0.1,
                max_chunk_secs: 0.5,
                silence_break_secs: 0.1,
                vad_sensitivity: 0.5,
            },
            16000,
            1,
        );

        // Simula áudio com voz (senoide)
        let mut speech = Vec::new();
        for i in 0..8000 {
            // 0.5s
            let t = i as f32 / 16000.0;
            speech.push((440.0 * t * 2.0 * std::f32::consts::PI).sin() * 0.5);
        }

        let chunk = chunker.push(&speech);
        assert!(
            chunk.is_some(),
            "Deveria produzir chunk ao atingir max_duration"
        );
    }

    #[test]
    fn test_chunker_produces_on_natural_break() {
        let mut chunker = SmartChunker::new(
            ChunkerConfig {
                min_chunk_secs: 0.1,
                max_chunk_secs: 30.0,
                silence_break_secs: 0.1,
                vad_sensitivity: 0.5,
            },
            16000,
            1,
        );

        // Simula fala
        let mut speech = Vec::new();
        for i in 0..3200 {
            // 0.2s de fala
            let t = i as f32 / 16000.0;
            speech.push((440.0 * t * 2.0 * std::f32::consts::PI).sin() * 0.5);
        }
        chunker.push(&speech);

        // Simula silêncio (pausa natural)
        let silence = vec![0.0; 2400]; // 0.15s de silêncio
        let chunk = chunker.push(&silence);

        assert!(chunk.is_some(), "Deveria produzir chunk na pausa natural");
    }

    #[test]
    fn test_mic_config_max_duration_is_10s() {
        // Mic config (hardcoded em audio/mod.rs): max_chunk_secs = 10.0
        let mut chunker = SmartChunker::new(
            ChunkerConfig {
                min_chunk_secs: 1.5,
                max_chunk_secs: 10.0,
                silence_break_secs: 0.5,
                vad_sensitivity: 0.55,
            },
            16000,
            1,
        );

        // Empurra 12s de áudio contínuo de fala (senoide) — deve forçar chunk em 10s.
        let mut speech = Vec::new();
        for i in 0..(16000 * 12) {
            let t = i as f32 / 16000.0;
            speech.push((440.0 * t * 2.0 * std::f32::consts::PI).sin() * 0.5);
        }

        // Empurra em blocos de 1600 samples (100ms) para simular streaming.
        let mut produced_chunk: Option<SpeechChunk> = None;
        for block in speech.chunks(1600) {
            if let Some(chunk) = chunker.push(block) {
                produced_chunk = Some(chunk);
                break;
            }
        }

        let chunk = produced_chunk.expect("Deveria produzir chunk ao atingir 10s");
        assert!(
            chunk.duration_secs <= 10.5, // pequena tolerância de 1 bloco
            "Chunk de mic deve respeitar max=10s, mas teve {:.2}s",
            chunk.duration_secs
        );
    }
}
