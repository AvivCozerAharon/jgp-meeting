/// http_client.rs
/// HTTP Client Singleton com connection pooling.
use once_cell::sync::Lazy;
use reqwest::Client;
use std::time::Duration;

/// HTTP Client global com connection pooling
pub static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .pool_max_idle_per_host(10)
        .pool_idle_timeout(Duration::from_secs(90))
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("JGP-Meeting/1.0")
        .build()
        .expect("Failed to create HTTP client")
});

/// HTTP Client com timeout estendido para uploads grandes
pub static HTTP_CLIENT_LONG: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .pool_max_idle_per_host(5)
        .pool_idle_timeout(Duration::from_secs(90))
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .user_agent("JGP-Meeting/1.0")
        .build()
        .expect("Failed to create HTTP client (long)")
});

/// Retorna referência ao client padrão
pub fn get_client() -> &'static Client {
    &HTTP_CLIENT
}

/// Retorna referência ao client com timeout longo
pub fn get_long_client() -> &'static Client {
    &HTTP_CLIENT_LONG
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_is_singleton() {
        let client1 = get_client() as *const Client;
        let client2 = get_client() as *const Client;
        assert_eq!(client1, client2, "Client should be singleton");
    }
}
