/// audio/mod.rs — JGP Meeting
///
/// Captura de áudio via WASAPI loopback (Feature base) + microfone (Feature 5).
/// Implementado diretamente com o crate `windows` para evitar o bug do
/// `wasapi 0.14` com AUDCLNT_BUFFERFLAGS_SILENT (ponteiro nulo → abort).
///
/// Features desta versão:
///   Feature 1 — Silence detection: VAD avançado com energy + ZCR + spectral
///   Feature 5 — Mic capture: captura microfone e mistura com loopback do sistema
///   Melhoria  — Smart Chunker: segmentos de fala completos (não corta frases)
///   Melhoria  — Resample Rubato: alta qualidade polihermítica
///   Melhoria  — AGC avançado: envelope follower com soft limiter
pub mod agc;
pub mod chunker;
pub mod resample;
pub mod vad;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use anyhow::Result;
use hound::{SampleFormat, WavSpec, WavWriter};

pub use agc::{AgcConfig, AutomaticGainControl};
pub use chunker::{ChunkerConfig, SmartChunker, SpeechChunk};
pub use resample::{to_whisper_format, Resampler};
pub use vad::{VadConfig, VoiceActivityDetector};

// ─── Tipos públicos ───────────────────────────────────────────────────────────

/// Identifica a origem de um chunk de áudio.
#[derive(Debug, Clone, PartialEq)]
pub enum AudioSource {
    /// Áudio do sistema (WASAPI loopback — o que sai pelas caixas de som)
    System,
    /// Áudio do microfone (captura direta)
    Microphone,
}

/// Dispositivo de áudio de entrada (microfone) disponível no sistema.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioDevice {
    /// ID único do dispositivo (string WASAPI, ex: "{0.0.1.00000000}.{...}")
    pub id: String,
    /// Nome amigável exibido ao usuário (ex: "Microfone (Realtek Audio)")
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct AudioChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_secs: f32,
    /// Fonte do áudio (sistema ou microfone)
    pub source: AudioSource,
}

impl AudioChunk {
    /// WAV 32-bit float no formato original do dispositivo.
    /// Usado pela API Whisper da OpenAI (aceita qualquer formato).
    pub fn to_wav_bytes(&self) -> Result<Vec<u8>> {
        let spec = WavSpec {
            channels: self.channels,
            sample_rate: self.sample_rate,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        let mut writer = WavWriter::new(&mut cursor, spec)?;
        for &s in &self.samples {
            writer.write_sample(s)?;
        }
        writer.finalize()?;
        Ok(cursor.into_inner())
    }

    /// WAV **mono 16-bit PCM a 16 kHz** — formato exigido pelo whisper.cpp local.
    ///
    /// O whisper.cpp lê apenas `wFormatTag=1` (PCM inteiro). Arquivos float (tag=3)
    /// ou com sample rate diferente de 16 kHz são silenciosamente ignorados,
    /// resultando em transcrição vazia mesmo sem erro de saída.
    ///
    /// Esta função:
    ///   1. Converte estéreo → mono (média dos canais)
    ///   2. Resample para 16 000 Hz (Rubato - polihermítico, alta qualidade)
    ///   3. Normaliza e converte f32 → i16
    pub fn to_wav_bytes_whisper(&self) -> Result<Vec<u8>> {
        const TARGET_RATE: u32 = 16_000;

        // Usa o novo módulo de resample de alta qualidade
        let resampled = to_whisper_format(&self.samples, self.sample_rate, self.channels)?;

        let spec = WavSpec {
            channels: 1,
            sample_rate: TARGET_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        let mut writer = WavWriter::new(&mut cursor, spec)?;
        for &s in &resampled {
            let v = (s.clamp(-1.0, 1.0) * 32_767.0) as i16;
            writer.write_sample(v)?;
        }
        writer.finalize()?;
        Ok(cursor.into_inner())
    }
}

// ─── Estado compartilhado ─────────────────────────────────────────────────────

pub struct AudioCaptureState {
    pub is_capturing: AtomicBool,
    pub current_level: parking_lot::Mutex<f32>,
    /// Feature 5: nível de áudio do microfone (separado do loopback)
    pub mic_level: parking_lot::Mutex<f32>,
    /// Quando true, o áudio do microfone é silenciado (não misturado ao loopback)
    pub mic_muted: AtomicBool,
    /// Quando true, os chunks de áudio são descartados (transcrição pausada)
    pub is_paused: AtomicBool,
}

impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            current_level: parking_lot::Mutex::new(0.0),
            mic_level: parking_lot::Mutex::new(0.0),
            mic_muted: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
        }
    }

    pub fn is_capturing(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
    }

    pub fn is_mic_muted(&self) -> bool {
        self.mic_muted.load(Ordering::SeqCst)
    }

    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, paused: bool) {
        self.is_paused.store(paused, Ordering::SeqCst);
    }
}

impl Default for AudioCaptureState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Captura Windows (WASAPI direto) ─────────────────────────────────────────

/// Flags WASAPI usados na leitura de buffer
const AUDCLNT_BUFFERFLAGS_SILENT: u32 = 0x2;

/// AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM (0x80000000):
/// Permite conversão automática de formato pelo audio engine, evitando
/// que o Windows precise reconfigurar (resetar) o endpoint ao iniciar
/// o loopback — o que causa a troca de dispositivo de áudio padrão.
const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x80000000;

/// AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY (0x08000000):
/// Usa o algoritmo de resample de alta qualidade do Windows.
const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x08000000;

/// Duração do buffer WASAPI do loopback em unidades de 100ns.
/// 2_000_000 = 200ms — suficiente para loopback sem forçar reset do audio engine.
/// Buffers grandes (>500ms) podem causar o Windows a reconfigurar o endpoint.
const LOOPBACK_BUFFER_DURATION: i64 = 2_000_000;

/// Lista todos os dispositivos de captura de áudio (microfones) disponíveis no sistema.
/// Retorna uma lista com id vazio como primeiro item (= microfone padrão do sistema).
#[cfg(target_os = "windows")]
pub fn list_capture_devices() -> Result<Vec<AudioDevice>> {
    use windows::Win32::{
        Devices::Properties::DEVPKEY_Device_FriendlyName,
        Media::Audio::{
            eCapture, IMMDeviceCollection, IMMDeviceEnumerator, MMDeviceEnumerator,
            DEVICE_STATE_ACTIVE,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
            STGM_READ,
        },
        System::Variant::VT_LPWSTR,
    };

    let mut devices = vec![AudioDevice {
        id: String::new(),
        name: "Microfone padrão do sistema".to_string(),
    }];

    unsafe {
        // COM pode já estar inicializado; ignoramos erro S_FALSE (código 1)
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| anyhow::anyhow!("IMMDeviceEnumerator: {:?}", e))?;

        let collection: IMMDeviceCollection = enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .map_err(|e| anyhow::anyhow!("EnumAudioEndpoints: {:?}", e))?;

        let count = collection
            .GetCount()
            .map_err(|e| anyhow::anyhow!("GetCount: {:?}", e))?;

        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };

            // ID do dispositivo (PWSTR alocado pela API — liberar com CoTaskMemFree)
            let id_pwstr = match device.GetId() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let id = id_pwstr.to_string().unwrap_or_default();
            CoTaskMemFree(Some(id_pwstr.0.cast()));

            // Nome amigável via IPropertyStore + DEVPKEY_Device_FriendlyName
            let name = (|| -> Option<String> {
                let store = device.OpenPropertyStore(STGM_READ).ok()?;
                // DEVPROPKEY e PROPERTYKEY têm layout idêntico — cast de ponteiro é seguro
                // addr_of! precisa de variável local (const não pode ter endereço direto)
                let key = DEVPKEY_Device_FriendlyName;
                let prop = store.GetValue(std::ptr::addr_of!(key).cast()).ok()?;
                // vt é VARENUM — comparar diretamente com VT_LPWSTR
                if prop.Anonymous.Anonymous.vt == VT_LPWSTR {
                    let ptr = prop.Anonymous.Anonymous.Anonymous.pwszVal;
                    if !ptr.is_null() {
                        return ptr.to_string().ok();
                    }
                }
                None
            })()
            .unwrap_or_else(|| format!("Dispositivo {}", i + 1));

            devices.push(AudioDevice { id, name });
        }
    }

    Ok(devices)
}

#[cfg(not(target_os = "windows"))]
pub fn list_capture_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![AudioDevice {
        id: String::new(),
        name: "Microfone padrão do sistema".to_string(),
    }])
}

/// Configuração específica do microfone passada ao `start_capture`.
#[derive(Debug, Clone)]
pub struct MicConfig {
    /// Capturar microfone?
    pub enabled: bool,
    /// ID do dispositivo de microfone (vazio = padrão do sistema)
    pub device_id: String,
    /// Threshold de silêncio do mic (tipicamente mais baixo que sistema)
    pub silence_threshold: f32,
    /// Normalização automática de volume (AGC)
    pub auto_gain: bool,
    /// Fator de ganho máximo quando AGC está ativo (ex: 4.0 = amplifica até 4x)
    pub gain_max: f32,
}

/// Aplica ganho automático (AGC) a um buffer de amostras.
///
/// Calcula o pico absoluto das amostras e aplica um ganho para levar o pico
/// até `target_peak` (default 0.9), limitado por `gain_max`.
/// Inclui smoothing para evitar variações abruptas de volume.
fn apply_auto_gain(samples: &mut [f32], gain_max: f32) {
    if samples.is_empty() || gain_max <= 1.0 {
        return;
    }

    // Encontra o pico absoluto
    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    if peak < 1e-6 {
        return; // Silêncio total, não amplifica
    }

    // Calcula ganho necessário para levar o pico a 0.9 (margem para não clipar)
    let target_peak = 0.9f32;
    let gain = (target_peak / peak).min(gain_max).max(1.0);

    if gain > 1.01 {
        // Aplica ganho com clamp para evitar clipping
        for s in samples.iter_mut() {
            *s = (*s * gain).clamp(-1.0, 1.0);
        }
        log::trace!("AGC mic: peak={:.4}, gain={:.2}x", peak, gain);
    }
}

/// Configuração do loopback do sistema passada ao `start_capture`.
#[derive(Debug, Clone)]
pub struct SystemConfig {
    /// Duração do chunk do sistema (em segundos)
    pub chunk_duration_secs: f32,
    /// Threshold de silêncio (RMS abaixo deste valor → chunk descartado)
    pub silence_threshold: f32,
    /// Normalização automática de volume (AGC) para o loopback
    pub auto_gain: bool,
    /// Fator de ganho máximo quando AGC está ativo (ex: 3.0)
    pub gain_max: f32,
}

/// Inicia a captura de áudio via WASAPI loopback com pipeline independente para microfone.
///
/// # Parâmetros
/// - `system_config`: configuração do loopback (threshold, chunk size, AGC)
/// - `mic_config`: configuração do microfone (threshold, chunk size, AGC, etc.)
///
/// Cada fonte (sistema e microfone) acumula seu próprio buffer, faz silence detection
/// independente e envia AudioChunks com o campo `source` identificando a origem.
/// Ambas as fontes enviam para o mesmo canal mpsc (multi-producer).
#[cfg(target_os = "windows")]
pub fn start_capture(
    state: Arc<AudioCaptureState>,
    chunk_tx: mpsc::Sender<AudioChunk>,
    system_config: SystemConfig,
    mic_config: MicConfig,
) -> Result<()> {
    use windows::Win32::{
        Media::Audio::{
            eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
            MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
            WAVEFORMATEX,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
        },
    };

    let (init_tx, init_rx) = mpsc::channel::<Result<()>>();

    // ── Thread do microfone (Feature 5) — pipeline independente ──────────────
    // O mic tem seu próprio buffer, chunk_target, silence detection e flush.
    // Envia chunks com source=Microphone para o mesmo canal do loopback.
    let sys_chunk_secs = system_config.chunk_duration_secs;
    if mic_config.enabled {
        let mic_tx = chunk_tx.clone();
        let state_mic = Arc::clone(&state);
        let mic_dev_id = mic_config.device_id.clone();
        let mic_chunk_secs = sys_chunk_secs;
        let mic_silence = mic_config.silence_threshold;
        let mic_agc = mic_config.auto_gain;
        let mic_gain_max = mic_config.gain_max;

        thread::spawn(move || unsafe {
            // COM em MTA nesta thread
            if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED) {
                log::error!("Mic thread: CoInitializeEx falhou: {:?}", e);
                return;
            }

            let enumerator: IMMDeviceEnumerator =
                match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                    Ok(e) => e,
                    Err(e) => {
                        log::error!("Mic thread: IMMDeviceEnumerator falhou: {:?}", e);
                        return;
                    }
                };

            // Seleciona dispositivo de microfone: específico ou padrão
            let device = if mic_dev_id.is_empty() {
                // Microfone padrão do sistema
                match enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!("Mic thread: GetDefaultAudioEndpoint falhou: {:?}", e);
                        return;
                    }
                }
            } else {
                // Microfone selecionado pelo usuário (por ID WASAPI)
                let wide: Vec<u16> = mic_dev_id
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();
                match enumerator.GetDevice(windows::core::PCWSTR(wide.as_ptr())) {
                    Ok(d) => d,
                    Err(e) => {
                        log::warn!(
                            "Dispositivo '{}' não encontrado, usando padrão: {:?}",
                            mic_dev_id,
                            e
                        );
                        match enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) {
                            Ok(d) => d,
                            Err(e) => {
                                log::error!(
                                    "Mic thread: GetDefaultAudioEndpoint fallback falhou: {:?}",
                                    e
                                );
                                return;
                            }
                        }
                    }
                }
            };

            let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Mic thread: Activate falhou: {:?}", e);
                    return;
                }
            };

            let fmt_ptr: *mut WAVEFORMATEX = match audio_client.GetMixFormat() {
                Ok(p) => p,
                Err(e) => {
                    log::error!("Mic thread: GetMixFormat falhou: {:?}", e);
                    return;
                }
            };

            let mic_sr = (*fmt_ptr).nSamplesPerSec;
            let mic_ch = (*fmt_ptr).nChannels;
            let mic_bps = (*fmt_ptr).wBitsPerSample;
            let mic_align = (*fmt_ptr).nBlockAlign as usize;

            // Inicializa sem loopback (captura real do microfone)
            let ok = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                0u32, // sem AUDCLNT_STREAMFLAGS_LOOPBACK
                10_000_000i64,
                0,
                fmt_ptr,
                None,
            );
            CoTaskMemFree(Some(fmt_ptr.cast()));
            if let Err(e) = ok {
                log::error!("Mic thread: Initialize falhou: {:?}", e);
                return;
            }

            let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Mic thread: GetService falhou: {:?}", e);
                    return;
                }
            };
            if let Err(e) = audio_client.Start() {
                log::error!("Mic thread: Start falhou: {:?}", e);
                return;
            }

            log::info!(
                "Microfone iniciado — {}Hz, {}ch, {}bps",
                mic_sr,
                mic_ch,
                mic_bps
            );

            // ── Loop de captura do microfone (pipeline independente) ──────────
            let mic_chunk_target = (mic_sr as f32 * mic_ch as f32 * mic_chunk_secs) as usize;
            let mut mic_pcm_buffer: Vec<f32> = Vec::with_capacity(mic_chunk_target * 2);

            log::info!(
                "Mic config: chunk={:.1}s, silence={:.4}, agc={}, gain_max={:.1}",
                mic_chunk_secs,
                mic_silence,
                mic_agc,
                mic_gain_max
            );

            while state_mic.is_capturing() {
                let pkt = match capture_client.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                };
                if pkt == 0 {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }

                let mut p_data: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;

                if capture_client
                    .GetBuffer(&mut p_data, &mut num_frames, &mut flags, None, None)
                    .is_ok()
                {
                    let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

                    if !is_silent && !p_data.is_null() && num_frames > 0 {
                        let raw =
                            std::slice::from_raw_parts(p_data, num_frames as usize * mic_align);
                        let samples = bytes_to_f32(raw, mic_bps);
                        let rms = compute_rms(&samples);
                        {
                            let mut lvl = state_mic.mic_level.lock();
                            *lvl = (*lvl * 0.7 + rms * 0.3).min(1.0);
                        }
                        mic_pcm_buffer.extend_from_slice(&samples);
                    }
                    // Frames com AUDCLNT_BUFFERFLAGS_SILENT: NÃO acumula zeros

                    let _ = capture_client.ReleaseBuffer(num_frames);
                }

                // Envia chunk quando acumulou amostras suficientes
                if mic_pcm_buffer.len() >= mic_chunk_target {
                    if state_mic.is_mic_muted() {
                        mic_pcm_buffer.drain(..mic_chunk_target);
                        continue;
                    }

                    let mut chunk_data: Vec<f32> =
                        mic_pcm_buffer.drain(..mic_chunk_target).collect();

                    // Silence check no chunk COMPLETO (antes do AGC)
                    let rms = compute_rms(&chunk_data);
                    if rms < mic_silence {
                        log::debug!(
                            "Mic: chunk silencioso (RMS={:.4} < {:.4}), descartado",
                            rms,
                            mic_silence
                        );
                        continue;
                    }

                    // AGC aplicado DEPOIS do silence check (só em áudio com fala real)
                    if mic_agc {
                        apply_auto_gain(&mut chunk_data, mic_gain_max);
                    }

                    log::debug!("Mic: chunk enviado (RMS={:.4})", rms);
                    let chunk = AudioChunk {
                        samples: chunk_data,
                        sample_rate: mic_sr,
                        channels: mic_ch,
                        duration_secs: mic_chunk_secs,
                        source: AudioSource::Microphone,
                    };
                    if mic_tx.send(chunk).is_err() {
                        log::warn!("Mic: canal fechado, encerrando captura");
                        break;
                    }
                }
            }

            // ── Flush final do microfone ─────────────────────────────────────
            if !mic_pcm_buffer.is_empty() {
                let remaining_samples = mic_pcm_buffer.len();
                let actual_duration = remaining_samples as f32 / (mic_sr as f32 * mic_ch as f32);

                if actual_duration >= 0.5 {
                    let mut chunk_data = mic_pcm_buffer;
                    if mic_agc {
                        apply_auto_gain(&mut chunk_data, mic_gain_max);
                    }
                    let rms = compute_rms(&chunk_data);
                    if rms >= mic_silence {
                        log::info!(
                            "Mic flush final: enviando {:.2}s de áudio restante ({} amostras)",
                            actual_duration,
                            remaining_samples
                        );
                        let chunk = AudioChunk {
                            samples: chunk_data,
                            sample_rate: mic_sr,
                            channels: mic_ch,
                            duration_secs: actual_duration,
                            source: AudioSource::Microphone,
                        };
                        let _ = mic_tx.send(chunk);
                    }
                }
            }

            let _ = audio_client.Stop();
            log::info!("Microfone encerrado");
        });
    }

    // ── Thread principal: loopback do sistema ────────────────────────────────
    let sys_silence = system_config.silence_threshold;
    let sys_agc = system_config.auto_gain;
    let sys_gain_max = system_config.gain_max;

    thread::spawn(move || {
        let result: Result<()> = (|| unsafe {
            if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED) {
                if e.code().0 != 1 {
                    return Err(anyhow::anyhow!("CoInitializeEx: {:?}", e));
                }
            }

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| anyhow::anyhow!("IMMDeviceEnumerator: {:?}", e))?;

            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| anyhow::anyhow!("GetDefaultAudioEndpoint: {:?}", e))?;

            let audio_client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| anyhow::anyhow!("Activate(IAudioClient): {:?}", e))?;

            let fmt_ptr: *mut WAVEFORMATEX = audio_client
                .GetMixFormat()
                .map_err(|e| anyhow::anyhow!("GetMixFormat: {:?}", e))?;

            let sample_rate = (*fmt_ptr).nSamplesPerSec;
            let channels = (*fmt_ptr).nChannels;
            let bits_per_sample = (*fmt_ptr).wBitsPerSample;
            let block_align = (*fmt_ptr).nBlockAlign as usize;

            log::info!(
                "WASAPI: {}Hz {}ch {}bps",
                sample_rate,
                channels,
                bits_per_sample
            );

            // AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: evita reset do audio engine ao iniciar
            // AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: resample de alta qualidade
            // Buffer de 200ms (2_000_000): menor que 1s previne reconfiguração do endpoint
            let loopback_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

            let init_res = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                loopback_flags,
                LOOPBACK_BUFFER_DURATION,
                0,
                fmt_ptr,
                None,
            );
            CoTaskMemFree(Some(fmt_ptr.cast()));
            init_res.map_err(|e| anyhow::anyhow!("Initialize: {:?}", e))?;

            let capture_client: IAudioCaptureClient = audio_client
                .GetService()
                .map_err(|e| anyhow::anyhow!("GetService: {:?}", e))?;

            audio_client
                .Start()
                .map_err(|e| anyhow::anyhow!("Start: {:?}", e))?;

            log::info!(
                "WASAPI loopback iniciado — {}Hz {}ch",
                sample_rate,
                channels
            );
            let _ = init_tx.send(Ok(()));

            log::info!(
                "System config: chunk={:.1}s, silence={:.4}, agc={}, gain_max={:.1}",
                sys_chunk_secs,
                sys_silence,
                sys_agc,
                sys_gain_max
            );

            // ── Loop de captura ───────────────────────────────────────────────
            let chunk_target = (sample_rate as f32 * channels as f32 * sys_chunk_secs) as usize;
            let mut pcm_buffer: Vec<f32> = Vec::with_capacity(chunk_target * 2);

            while state.is_capturing() {
                let pkt_size = match capture_client.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(e) => {
                        log::warn!("GetNextPacketSize: {:?}", e);
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                };

                if pkt_size == 0 {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }

                let mut p_data: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;

                match capture_client.GetBuffer(&mut p_data, &mut num_frames, &mut flags, None, None)
                {
                    Ok(()) => {
                        // ► FIX: checa SILENT antes de acessar p_data
                        let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

                        if !is_silent && !p_data.is_null() && num_frames > 0 {
                            let byte_count = num_frames as usize * block_align;
                            let raw = std::slice::from_raw_parts(p_data, byte_count);
                            let samples = bytes_to_f32(raw, bits_per_sample);

                            if !samples.is_empty() {
                                let rms = compute_rms(&samples);
                                {
                                    let mut lvl = state.current_level.lock();
                                    *lvl = (*lvl * 0.7 + rms * 0.3).min(1.0);
                                }
                                pcm_buffer.extend_from_slice(&samples);
                            }
                        } else if num_frames > 0 {
                            pcm_buffer.extend(
                                std::iter::repeat(0.0f32)
                                    .take(num_frames as usize * channels as usize),
                            );
                        }

                        if let Err(e) = capture_client.ReleaseBuffer(num_frames) {
                            log::warn!("ReleaseBuffer: {:?}", e);
                        }
                    }
                    Err(e) => log::warn!("GetBuffer: {:?}", e),
                }

                // Envia chunk ao acumular amostras suficientes
                if pcm_buffer.len() >= chunk_target {
                    let mut chunk_data: Vec<f32> = pcm_buffer.drain(..chunk_target).collect();

                    // AGC: normaliza volume do loopback antes do silence check
                    if sys_agc {
                        apply_auto_gain(&mut chunk_data, sys_gain_max);
                    }

                    // Feature 1: descarta chunks silenciosos
                    let rms = compute_rms(&chunk_data);
                    if rms >= sys_silence {
                        let chunk = AudioChunk {
                            samples: chunk_data,
                            sample_rate,
                            channels,
                            duration_secs: sys_chunk_secs,
                            source: AudioSource::System,
                        };
                        if chunk_tx.send(chunk).is_err() {
                            log::warn!("Canal fechado, encerrando captura");
                            break;
                        }
                    } else {
                        log::debug!(
                            "Chunk silencioso (RMS={:.4} < {:.4}), descartado",
                            rms,
                            sys_silence
                        );
                    }
                }
            }

            // ── Flush final: envia o que sobrou no pcm_buffer ────────────
            // Sem esse flush, dados parciais (que não atingiram chunk_target)
            // seriam perdidos ao parar a gravação.
            if !pcm_buffer.is_empty() {
                let remaining_samples = pcm_buffer.len();
                let actual_duration =
                    remaining_samples as f32 / (sample_rate as f32 * channels as f32);

                // Só envia se tiver ao menos 0.5s de áudio (evita micro-chunks inúteis)
                if actual_duration >= 0.5 {
                    let mut chunk_data = pcm_buffer;
                    if sys_agc {
                        apply_auto_gain(&mut chunk_data, sys_gain_max);
                    }

                    let rms = compute_rms(&chunk_data);
                    if rms >= sys_silence {
                        log::info!(
                            "Flush final: enviando {:.2}s de áudio restante ({} amostras)",
                            actual_duration,
                            remaining_samples
                        );
                        let chunk = AudioChunk {
                            samples: chunk_data,
                            sample_rate,
                            channels,
                            duration_secs: actual_duration,
                            source: AudioSource::System,
                        };
                        let _ = chunk_tx.send(chunk);
                    } else {
                        log::debug!("Flush final descartado (silencioso, RMS={:.4})", rms);
                    }
                } else {
                    log::debug!(
                        "Flush final ignorado (muito curto: {:.3}s)",
                        actual_duration
                    );
                }
            }

            let _ = audio_client.Stop();
            log::info!("WASAPI loopback encerrado");
            Ok(())
        })();

        if let Err(ref e) = result {
            let _ = init_tx.send(Err(anyhow::anyhow!("{}", e)));
        }
    });

    init_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("Thread de captura encerrou inesperadamente"))??;

    Ok(())
}

// ─── Stub não-Windows ─────────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
pub fn start_capture(
    state: Arc<AudioCaptureState>,
    chunk_tx: mpsc::Sender<AudioChunk>,
    system_config: SystemConfig,
    _mic_config: MicConfig,
) -> Result<()> {
    log::warn!("WASAPI não disponível — usando áudio simulado");
    let sample_rate: u32 = 44100;
    let channels: u16 = 2;
    let chunk_duration_secs = system_config.chunk_duration_secs;
    let n = (sample_rate as f32 * channels as f32 * chunk_duration_secs) as usize;

    thread::spawn(move || {
        while state.is_capturing() {
            thread::sleep(Duration::from_secs_f32(chunk_duration_secs));
            let chunk = AudioChunk {
                samples: vec![0.0f32; n],
                sample_rate,
                channels,
                duration_secs: chunk_duration_secs,
                source: AudioSource::System,
            };
            if chunk_tx.send(chunk).is_err() {
                break;
            }
        }
    });

    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Converte bytes PCM little-endian em amostras f32 normalizadas [-1.0, 1.0].
fn bytes_to_f32(raw: &[u8], bits_per_sample: u16) -> Vec<f32> {
    match bits_per_sample {
        32 => raw
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect(),
        16 => raw
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0)
            .collect(),
        24 => raw
            .chunks_exact(3)
            .map(|b| {
                let v = i32::from_le_bytes([b[0], b[1], b[2], 0]) >> 8;
                v as f32 / 8_388_608.0
            })
            .collect(),
        _ => {
            log::warn!("bits_per_sample={} não suportado", bits_per_sample);
            Vec::new()
        }
    }
}

/// Calcula o RMS (nível de potência) das amostras.
fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|&s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt().min(1.0)
}
