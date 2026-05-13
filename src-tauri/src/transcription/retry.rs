/// transcription/retry.rs
/// Retry logic com backoff exponencial para chamadas de API.

use anyhow::Result;
use std::time::Duration;

/// Configuração de retry
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Número máximo de tentativas
    pub max_retries: usize,
    /// Delay inicial em ms
    pub initial_delay_ms: u64,
    /// Delay máximo em ms
    pub max_delay_ms: u64,
    /// Multiplicador do backoff
    pub multiplier: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_delay_ms: 100,
            max_delay_ms: 10000,
            multiplier: 2.0,
        }
    }
}

/// Estratégia de backoff exponencial
pub struct ExponentialBackoff {
    config: RetryConfig,
    attempt: usize,
    current_delay: Duration,
}

impl ExponentialBackoff {
    pub fn new(config: RetryConfig) -> Self {
        Self {
            current_delay: Duration::from_millis(config.initial_delay_ms),
            config,
            attempt: 0,
        }
    }

    pub fn with_max_retries(max_retries: usize) -> Self {
        Self::new(RetryConfig {
            max_retries,
            ..Default::default()
        })
    }

    /// Retorna o próximo delay, ou None se excedeu o máximo de tentativas
    pub fn next_delay(&mut self) -> Option<Duration> {
        if self.attempt >= self.config.max_retries {
            return None;
        }

        let delay = self.current_delay;
        self.attempt += 1;

        // Calcula próximo delay
        let next_ms = (self.current_delay.as_millis() as f64 * self.config.multiplier) as u64;
        self.current_delay = Duration::from_millis(next_ms.min(self.config.max_delay_ms));

        Some(delay)
    }

    pub fn attempt(&self) -> usize {
        self.attempt
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
        self.current_delay = Duration::from_millis(self.config.initial_delay_ms);
    }
}

/// Executa uma operação assíncrona com retry
pub async fn retry_async<F, Fut, T, E>(
    config: RetryConfig,
    mut operation: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Debug,
{
    let mut backoff = ExponentialBackoff::new(config);

    loop {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if let Some(delay) = backoff.next_delay() {
                    log::warn!(
                        "Tentativa {} falhou: {:?}, tentando novamente em {:?}",
                        backoff.attempt(),
                        e,
                        delay
                    );
                    tokio::time::sleep(delay).await;
                } else {
                    return Err(anyhow::anyhow!(
                        "Operação falhou após {} tentativas: {:?}",
                        backoff.attempt(),
                        e
                    ));
                }
            }
        }
    }
}

/// Executa uma operação com retry, aceitando uma closure que retorna Result<T>
pub async fn retry_operation<T, F>(
    config: RetryConfig,
    mut operation: F,
) -> Result<T>
where
    F: FnMut() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send>> + Send,
{
    let mut backoff = ExponentialBackoff::new(config);

    loop {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if let Some(delay) = backoff.next_delay() {
                    log::warn!(
                        "Tentativa {} falhou: {}, tentando novamente em {:?}",
                        backoff.attempt(),
                        e,
                        delay
                    );
                    tokio::time::sleep(delay).await;
                } else {
                    return Err(anyhow::anyhow!(
                        "Operação falhou após {} tentativas: {}",
                        backoff.attempt(),
                        e
                    ));
                }
            }
        }
    }
}

/// Error type for transcription API calls.
/// `Retryable` errors (429, 5xx, network) will be retried with backoff.
/// `Permanent` errors (4xx except 429) fail immediately without retrying.
#[derive(Debug)]
pub enum TranscriptionError {
    Retryable(String),
    Permanent(String),
}

impl std::fmt::Display for TranscriptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Retryable(msg) | Self::Permanent(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for TranscriptionError {}

/// Retry loop that distinguishes retryable from permanent transcription errors.
pub async fn retry_transcription<F>(
    config: RetryConfig,
    mut operation: F,
) -> anyhow::Result<String>
where
    F: FnMut() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, TranscriptionError>> + Send>> + Send,
{
    let mut backoff = ExponentialBackoff::new(config);
    loop {
        match operation().await {
            Ok(text) => return Ok(text),
            Err(TranscriptionError::Permanent(msg)) => {
                return Err(anyhow::anyhow!("{}", msg));
            }
            Err(TranscriptionError::Retryable(msg)) => {
                if let Some(delay) = backoff.next_delay() {
                    log::warn!(
                        "Retryable transcription error (attempt {}): {}, retrying in {:?}",
                        backoff.attempt(),
                        msg,
                        delay
                    );
                    tokio::time::sleep(delay).await;
                } else {
                    return Err(anyhow::anyhow!(
                        "Transcription failed after {} retries: {}",
                        backoff.attempt(),
                        msg
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backoff_sequence() {
        let config = RetryConfig {
            max_retries: 5,
            initial_delay_ms: 100,
            max_delay_ms: 5000,
            multiplier: 2.0,
        };
        let mut backoff = ExponentialBackoff::new(config);

        assert_eq!(backoff.next_delay(), Some(Duration::from_millis(100)));
        assert_eq!(backoff.next_delay(), Some(Duration::from_millis(200)));
        assert_eq!(backoff.next_delay(), Some(Duration::from_millis(400)));
        assert_eq!(backoff.next_delay(), Some(Duration::from_millis(800)));
        assert_eq!(backoff.next_delay(), None); // Exceeded max_retries
    }

    #[test]
    fn test_backoff_max_delay() {
        let config = RetryConfig {
            max_retries: 10,
            initial_delay_ms: 1000,
            max_delay_ms: 3000,
            multiplier: 2.0,
        };
        let mut backoff = ExponentialBackoff::new(config);

        backoff.next_delay(); // 1000
        backoff.next_delay(); // 2000
        let delay = backoff.next_delay(); // Would be 4000, but capped at 3000
        assert_eq!(delay, Some(Duration::from_millis(3000)));
    }

    #[tokio::test]
    async fn test_retry_success_on_second_attempt() {
        let config = RetryConfig {
            max_retries: 3,
            initial_delay_ms: 10,
            max_delay_ms: 100,
            multiplier: 2.0,
        };

        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts2 = attempts.clone();
        let result = retry_async(config, move || {
            let attempts = attempts2.clone();
            async move {
                let n = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n < 1 {
                    Err::<i32, &str>("fail")
                } else {
                    Ok(42)
                }
            }
        })
        .await;

        assert_eq!(result.unwrap(), 42);
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_retry_transcription_permanent_no_retry() {
        let config = RetryConfig {
            max_retries: 3,
            initial_delay_ms: 10,
            max_delay_ms: 100,
            multiplier: 2.0,
        };
        let mut call_count = 0usize;
        let result = retry_transcription(config, || {
            call_count += 1;
            Box::pin(async {
                Err::<String, TranscriptionError>(TranscriptionError::Permanent("401 Unauthorized".into()))
            })
        }).await;
        assert!(result.is_err());
        assert_eq!(call_count, 1, "Permanent error must not be retried");
    }

    #[tokio::test]
    async fn test_retry_transcription_retryable_retries() {
        let config = RetryConfig {
            max_retries: 3,
            initial_delay_ms: 10,
            max_delay_ms: 100,
            multiplier: 2.0,
        };
        let mut call_count = 0usize;
        let result = retry_transcription(config, || {
            call_count += 1;
            Box::pin(async move {
                if call_count < 3 {
                    Err::<String, TranscriptionError>(TranscriptionError::Retryable("503 unavailable".into()))
                } else {
                    Ok("hello world".into())
                }
            })
        }).await;
        assert_eq!(result.unwrap(), "hello world");
        assert_eq!(call_count, 3);
    }
}
