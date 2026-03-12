/// audio/mod.rs — JGP Meeting
///
/// Captura de áudio via WASAPI loopback (Feature base) + microfone (Feature 5).
/// Implementado diretamente com o crate `windows` para evitar o bug do
/// `wasapi 0.14` com AUDCLNT_BUFFERFLAGS_SILENT (ponteiro nulo → abort).
///
/// Features desta versão:
///   Feature 1 — Silence detection: chunks com RMS abaixo do threshold são descartados
///   Feature 5 — Mic capture: captura microfone e mistura com loopback do sistema
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::Result;
use hound::{SampleFormat, WavSpec, WavWriter};

// ─── Tipos públicos ───────────────────────────────────────────────────────────

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
    ///   2. Reamostara para 16 000 Hz (interpolação linear)
    ///   3. Normaliza e converte f32 → i16
    pub fn to_wav_bytes_whisper(&self) -> Result<Vec<u8>> {
        // ── 1. Estéreo → mono ─────────────────────────────────────────────────
        let ch = self.channels as usize;
        let mono: Vec<f32> = if ch == 1 {
            self.samples.clone()
        } else {
            self.samples
                .chunks_exact(ch)
                .map(|frame| frame.iter().sum::<f32>() / ch as f32)
                .collect()
        };

        // ── 2. Resample para 16 000 Hz ────────────────────────────────────────
        const TARGET_RATE: u32 = 16_000;
        let resampled: Vec<f32> = if self.sample_rate == TARGET_RATE {
            mono
        } else {
            let ratio = self.sample_rate as f64 / TARGET_RATE as f64;
            let out_len = ((mono.len() as f64) / ratio).ceil() as usize;
            (0..out_len)
                .map(|i| {
                    let pos = i as f64 * ratio;
                    let lo = pos.floor() as usize;
                    let hi = (lo + 1).min(mono.len().saturating_sub(1));
                    let t = pos.fract() as f32;
                    mono[lo] * (1.0 - t) + mono[hi] * t
                })
                .collect()
        };

        // ── 3. f32 [-1,1] → i16 e escrita do WAV ─────────────────────────────
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
    pub current_level: Mutex<f32>,
    /// Feature 5: nível de áudio do microfone (separado do loopback)
    pub mic_level: Mutex<f32>,
    /// Quando true, o áudio do microfone é silenciado (não misturado ao loopback)
    pub mic_muted: AtomicBool,
}

impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            current_level: Mutex::new(0.0),
            mic_level: Mutex::new(0.0),
            mic_muted: AtomicBool::new(false),
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

/// Inicia a captura de áudio via WASAPI loopback com suporte opcional ao microfone.
///
/// # Parâmetros
/// - `silence_threshold`: chunks com RMS abaixo deste valor são descartados (Feature 1)
/// - `capture_mic`: se true, mistura o microfone com o áudio do sistema (Feature 5)
/// - `mic_device_id`: ID do dispositivo de microfone a usar; vazio = padrão do sistema
#[cfg(target_os = "windows")]
pub fn start_capture(
    state: Arc<AudioCaptureState>,
    chunk_tx: mpsc::Sender<AudioChunk>,
    chunk_duration_secs: f32,
    silence_threshold: f32,
    capture_mic: bool,
    mic_device_id: String,
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

    // Feature 5: buffer compartilhado entre thread do mic e thread de loopback
    let mic_buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    // ── Thread do microfone (Feature 5) ───────────────────────────────────────
    if capture_mic {
        let mic_buf = Arc::clone(&mic_buffer);
        let state_mic = Arc::clone(&state);
        let mic_dev_id = mic_device_id.clone();

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

            log::info!("Microfone iniciado — {}Hz, {}ch", mic_sr, mic_ch);

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
                        if let Ok(mut lvl) = state_mic.mic_level.lock() {
                            *lvl = (*lvl * 0.7 + rms * 0.3).min(1.0);
                        }
                        if let Ok(mut buf) = mic_buf.lock() {
                            buf.extend_from_slice(&samples);
                            // Limita o buffer a 5 segundos para evitar dessincronia
                            let max = mic_sr as usize * mic_ch as usize * 5;
                            if buf.len() > max {
                                let excess = buf.len() - max;
                                buf.drain(..excess);
                            }
                        }
                    } else if num_frames > 0 {
                        // Frames silenciosos: empurra zeros
                        if let Ok(mut buf) = mic_buf.lock() {
                            buf.extend(
                                std::iter::repeat(0.0f32)
                                    .take(num_frames as usize * mic_ch as usize),
                            );
                        }
                    }

                    let _ = capture_client.ReleaseBuffer(num_frames);
                }
            }

            let _ = audio_client.Stop();
            log::info!("Microfone encerrado");
        });
    }

    // ── Thread principal: loopback do sistema ────────────────────────────────
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

            // ── Loop de captura ───────────────────────────────────────────────
            let chunk_target =
                (sample_rate as f32 * channels as f32 * chunk_duration_secs) as usize;
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
                                if let Ok(mut lvl) = state.current_level.lock() {
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

                    // Feature 5: mistura com microfone (se não estiver mutado)
                    // Reduz gain para evitar saturação quando ambos têm áudio
                    if capture_mic && !state.is_mic_muted() {
                        if let Ok(mut mic_buf) = mic_buffer.lock() {
                            let mic_len = mic_buf.len().min(chunk_target);
                            if mic_len > 0 {
                                let mic_chunk: Vec<f32> = mic_buf.drain(..mic_len).collect();
                                for (s, &m) in chunk_data.iter_mut().zip(mic_chunk.iter()) {
                                    // Reduz gain para 50% antes de somar para evitar distorção
                                    *s = (*s * 0.5 + m * 0.5).clamp(-1.0, 1.0);
                                }
                            }
                        }
                    } else if capture_mic && state.is_mic_muted() {
                        // Descarta buffer do mic acumulado para não dessincronizar
                        if let Ok(mut mic_buf) = mic_buffer.lock() {
                            mic_buf.clear();
                        }
                    }

                    // Feature 1: descarta chunks silenciosos
                    let rms = compute_rms(&chunk_data);
                    if rms >= silence_threshold {
                        let chunk = AudioChunk {
                            samples: chunk_data,
                            sample_rate,
                            channels,
                            duration_secs: chunk_duration_secs,
                        };
                        if chunk_tx.send(chunk).is_err() {
                            log::warn!("Canal fechado, encerrando captura");
                            break;
                        }
                    } else {
                        log::debug!(
                            "Chunk silencioso (RMS={:.4} < {:.4}), descartado",
                            rms,
                            silence_threshold
                        );
                    }
                }
            }

            // ── Flush final: envia o que sobrou no pcm_buffer ────────────
            // Sem esse flush, dados parciais (que não atingiram chunk_target)
            // seriam perdidos ao parar a gravação. Isso é crítico para o modelo
            // local (Whisper), que é mais lento e acumula mais chunks pendentes.
            if !pcm_buffer.is_empty() {
                let remaining_samples = pcm_buffer.len();
                let actual_duration =
                    remaining_samples as f32 / (sample_rate as f32 * channels as f32);

                // Só envia se tiver ao menos 0.5s de áudio (evita micro-chunks inúteis)
                if actual_duration >= 0.5 {
                    let mut chunk_data = pcm_buffer;

                    // Feature 5: mistura com microfone restante (se não mutado)
                    // Reduz gain para evitar saturação
                    if capture_mic && !state.is_mic_muted() {
                        if let Ok(mut mic_buf) = mic_buffer.lock() {
                            let mic_len = mic_buf.len().min(chunk_data.len());
                            if mic_len > 0 {
                                let mic_chunk: Vec<f32> = mic_buf.drain(..mic_len).collect();
                                for (s, &m) in chunk_data.iter_mut().zip(mic_chunk.iter()) {
                                    *s = (*s * 0.5 + m * 0.5).clamp(-1.0, 1.0);
                                }
                            }
                        }
                    }

                    let rms = compute_rms(&chunk_data);
                    if rms >= silence_threshold {
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
    chunk_duration_secs: f32,
    _silence_threshold: f32,
    _capture_mic: bool,
    _mic_device_id: String,
) -> Result<()> {
    log::warn!("WASAPI não disponível — usando áudio simulado");
    let sample_rate: u32 = 44100;
    let channels: u16 = 2;
    let n = (sample_rate as f32 * channels as f32 * chunk_duration_secs) as usize;

    thread::spawn(move || {
        while state.is_capturing() {
            thread::sleep(Duration::from_secs_f32(chunk_duration_secs));
            let chunk = AudioChunk {
                samples: vec![0.0f32; n],
                sample_rate,
                channels,
                duration_secs: chunk_duration_secs,
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
