# DPAPI Encryption for Sensitive Settings Fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt 5 sensitive fields in `AppSettings` at rest using Windows DPAPI so they are never written as plain text to `settings.json`.

**Architecture:** A new `crypto.rs` module wraps `CryptProtectData`/`CryptUnprotectData` from the `windows` crate. `storage/mod.rs` clones settings before saving (encrypting the 5 fields), and decrypts them on load. No changes to the frontend or Tauri command layer. Old plain-text values silently become `""` on first load (reset behavior).

**Tech Stack:** Rust, `windows` crate 0.52 (Win32 DPAPI), `base64` 0.22 (already in Cargo.toml)

---

## File Map

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Add 2 features to existing `windows` dependency |
| `src-tauri/src/crypto.rs` | **New** — `encrypt_string` / `decrypt_string` wrappers |
| `src-tauri/src/main.rs` | Add `mod crypto;` |
| `src-tauri/src/storage/mod.rs` | Encrypt on `save_settings`, decrypt on `load_settings` |

---

## Task 1: Add DPAPI features to `windows` dependency

**Files:**
- Modify: `src-tauri/Cargo.toml:52-63`

- [ ] **Step 1: Edit Cargo.toml**

Find the existing `[target.'cfg(windows)'.dependencies]` block. It currently lists 7 features for the `windows` crate. Add `"Win32_Security_Cryptography"` and `"Win32_System_Memory"` to the list:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.52", features = [
    "Win32_Foundation",
    "Win32_Media_Audio",
    "Win32_System_Com",
    "Win32_System_Com_StructuredStorage",
    "Win32_System_Variant",
    "Win32_Devices_Properties",
    "Win32_UI_Shell_PropertiesSystem",
    "Win32_Security_Cryptography",
    "Win32_System_Memory",
] }
```

- [ ] **Step 2: Verify the dependency resolves**

```bash
cd src-tauri && cargo fetch
```

Expected: no errors. If `windows` feature names are wrong, `cargo fetch` will error with "Package `windows` does not have feature `...`".

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "build: add Win32_Security_Cryptography + Win32_System_Memory features"
```

---

## Task 2: Create `crypto.rs` with DPAPI wrappers + tests

**Files:**
- Create: `src-tauri/src/crypto.rs`

- [ ] **Step 1: Write the failing tests first**

Create `src-tauri/src/crypto.rs` with just the test module:

```rust
// src-tauri/src/crypto.rs
// Wrappers over Windows DPAPI (CryptProtectData / CryptUnprotectData).
// Encrypts/decrypts UTF-8 strings; encrypted form is base64-encoded DPAPI blob.

#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD, Engine};

#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::HLOCAL,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
            CRYPTPROTECT_FLAGS, CRYPTPROTECT_PROMPTSTRUCT,
        },
        System::Memory::LocalFree,
    },
};

/// Encrypts `plaintext` with DPAPI, returns base64-encoded ciphertext.
/// Empty input returns empty string without calling DPAPI.
#[cfg(windows)]
pub fn encrypt_string(plaintext: &str) -> Result<String, String> {
    todo!()
}

/// Decrypts a base64-encoded DPAPI blob back to plaintext.
/// Empty input returns empty string without calling DPAPI.
/// Returns `Err` on invalid base64 or DPAPI failure.
#[cfg(windows)]
pub fn decrypt_string(encoded: &str) -> Result<String, String> {
    todo!()
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = "sk-test1234567890abcdef";
        let encrypted = encrypt_string(plaintext).expect("encrypt should succeed");
        assert_ne!(encrypted, plaintext, "encrypted value must differ from plaintext");
        let decrypted = decrypt_string(&encrypted).expect("decrypt should succeed");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_empty_string_passthrough() {
        assert_eq!(encrypt_string("").unwrap(), "");
        assert_eq!(decrypt_string("").unwrap(), "");
    }

    #[test]
    fn test_invalid_base64_returns_err() {
        let result = decrypt_string("not!!valid!!base64");
        assert!(result.is_err());
    }

    #[test]
    fn test_valid_base64_but_invalid_dpapi_returns_err() {
        // Valid base64, but the bytes are not a DPAPI blob
        let fake = base64::engine::general_purpose::STANDARD.encode(b"garbage bytes");
        let result = decrypt_string(&fake);
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test crypto::tests -- --nocapture 2>&1 | head -30
```

Expected: compile error `not yet implemented` (the `todo!()` panics at test time, or compilation fails because `todo!()` in non-`#[test]` context needs the function to at least return the right type).

- [ ] **Step 3: Implement `encrypt_string` and `decrypt_string`**

Replace the two `todo!()` bodies with the real implementation:

```rust
#[cfg(windows)]
pub fn encrypt_string(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }

    let mut input_data = plaintext.as_bytes().to_vec();
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_data.len() as u32,
        pbData: input_data.as_mut_ptr(),
    };
    let mut output_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        CryptProtectData(
            &input_blob,
            PCWSTR::null(),
            std::ptr::null::<CRYPT_INTEGER_BLOB>(),
            std::ptr::null_mut::<std::ffi::c_void>(),
            std::ptr::null::<CRYPTPROTECT_PROMPTSTRUCT>(),
            CRYPTPROTECT_FLAGS(0),
            &mut output_blob,
        )
        .map_err(|e| format!("DPAPI encrypt failed: {e}"))?;

        let encrypted: Vec<u8> =
            std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize)
                .to_vec();

        LocalFree(HLOCAL(output_blob.pbData as *mut std::ffi::c_void));

        Ok(STANDARD.encode(&encrypted))
    }
}

#[cfg(windows)]
pub fn decrypt_string(encoded: &str) -> Result<String, String> {
    if encoded.is_empty() {
        return Ok(String::new());
    }

    let mut encrypted = STANDARD
        .decode(encoded)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        CryptUnprotectData(
            &input_blob,
            std::ptr::null_mut(),
            std::ptr::null::<CRYPT_INTEGER_BLOB>(),
            std::ptr::null_mut::<std::ffi::c_void>(),
            std::ptr::null::<CRYPTPROTECT_PROMPTSTRUCT>(),
            CRYPTPROTECT_FLAGS(0),
            &mut output_blob,
        )
        .map_err(|e| format!("DPAPI decrypt failed: {e}"))?;

        let plaintext_bytes: Vec<u8> =
            std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize)
                .to_vec();

        LocalFree(HLOCAL(output_blob.pbData as *mut std::ffi::c_void));

        String::from_utf8(plaintext_bytes).map_err(|e| format!("UTF-8 decode failed: {e}"))
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test crypto::tests -- --nocapture
```

Expected output (all 4 pass):
```
test crypto::tests::test_empty_string_passthrough ... ok
test crypto::tests::test_encrypt_decrypt_roundtrip ... ok
test crypto::tests::test_invalid_base64_returns_err ... ok
test crypto::tests::test_valid_base64_but_invalid_dpapi_returns_err ... ok

test result: ok. 4 passed; 0 failed
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/crypto.rs
git commit -m "feat(crypto): add DPAPI encrypt_string/decrypt_string wrappers"
```

---

## Task 3: Register `mod crypto` in `main.rs`

**Files:**
- Modify: `src-tauri/src/main.rs:4-11`

- [ ] **Step 1: Add the module declaration**

In `src-tauri/src/main.rs`, add `mod crypto;` alongside the other module declarations (lines 4–11). Insert it in alphabetical order:

```rust
mod ai;
mod audio;
mod commands;
mod crypto;      // ← add this line
mod detection;
mod export;
mod storage;
mod text_processing;
mod transcription;
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: `warning: unused import` at most, no errors. If `dead_code` warnings appear for `encrypt_string`/`decrypt_string`, that's fine — they'll be used in Task 4.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "chore: register crypto module in main.rs"
```

---

## Task 4: Encrypt on save and decrypt on load in `storage/mod.rs`

**Files:**
- Modify: `src-tauri/src/storage/mod.rs:403-422`

- [ ] **Step 1: Write failing tests first**

Add this test module at the bottom of `src-tauri/src/storage/mod.rs` (after the last existing line):

```rust
#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;

    #[test]
    fn test_save_load_roundtrip_encrypts_sensitive_fields() {
        // Save settings with a known API key
        let mut settings = AppSettings::with_defaults();
        settings.openai_api_key = "sk-roundtrip-test-key".to_string();
        settings.groq_api_key = "gsk-roundtrip-groq".to_string();

        save_settings(&settings).expect("save should succeed");

        // The raw JSON on disk must NOT contain the plain-text key
        let path = settings_file_path().unwrap();
        let raw_json = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw_json.contains("sk-roundtrip-test-key"),
            "plain openai_api_key must not appear in settings.json"
        );
        assert!(
            !raw_json.contains("gsk-roundtrip-groq"),
            "plain groq_api_key must not appear in settings.json"
        );

        // load_settings must decrypt back to the original values
        let loaded = load_settings().expect("load should succeed");
        assert_eq!(loaded.openai_api_key, "sk-roundtrip-test-key");
        assert_eq!(loaded.groq_api_key, "gsk-roundtrip-groq");

        // Clean up: restore empty settings
        save_settings(&AppSettings::with_defaults()).unwrap();
    }

    #[test]
    fn test_plaintext_keys_in_old_settings_return_empty_on_load() {
        // Simulate a pre-encryption settings.json by writing plain-text JSON directly
        let path = settings_file_path().unwrap();
        let mut old = AppSettings::with_defaults();
        // Temporarily use serde to get a clean base JSON,
        // then patch in a plain-text key before writing
        let mut json_value: serde_json::Value =
            serde_json::to_value(&old).unwrap();
        json_value["openai_api_key"] = serde_json::json!("sk-old-plain-text-key");
        std::fs::write(&path, serde_json::to_string_pretty(&json_value).unwrap()).unwrap();

        let loaded = load_settings().expect("load should not fail");
        assert_eq!(
            loaded.openai_api_key, "",
            "old plain-text key must be reset to empty string"
        );

        // Clean up
        save_settings(&AppSettings::with_defaults()).unwrap();
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test storage::tests -- --nocapture 2>&1 | head -30
```

Expected: tests fail because `save_settings` does not yet encrypt (the raw JSON will contain the plain key).

- [ ] **Step 3: Update `save_settings` to encrypt before writing**

Replace the current `save_settings` function (lines 415–422 in `storage/mod.rs`) with:

```rust
pub fn save_settings(settings: &AppSettings) -> Result<()> {
    let path = settings_file_path()?;

    // Clone and encrypt sensitive fields before serializing to disk.
    // If any encryption fails, abort — never write a partially-protected file.
    let mut storable = settings.clone();
    storable.openai_api_key = crate::crypto::encrypt_string(&settings.openai_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar openai_api_key: {e}"))?;
    storable.groq_api_key = crate::crypto::encrypt_string(&settings.groq_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar groq_api_key: {e}"))?;
    storable.openrouter_api_key = crate::crypto::encrypt_string(&settings.openrouter_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar openrouter_api_key: {e}"))?;
    storable.google_cloud_api_key = crate::crypto::encrypt_string(&settings.google_cloud_api_key)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar google_cloud_api_key: {e}"))?;
    storable.jgrc_session_cookie = crate::crypto::encrypt_string(&settings.jgrc_session_cookie)
        .map_err(|e| anyhow::anyhow!("Falha ao encriptar jgrc_session_cookie: {e}"))?;

    let json = serde_json::to_string_pretty(&storable)
        .context("Falha ao serializar configurações")?;
    fs::write(&path, json).context("Falha ao salvar configurações")?;
    log::info!("Configurações salvas");
    Ok(())
}
```

- [ ] **Step 4: Update `load_settings` to decrypt after reading**

Replace the current `load_settings` function (lines 403–413 in `storage/mod.rs`) with:

```rust
pub fn load_settings() -> Result<AppSettings> {
    let path = settings_file_path()?;
    if !path.exists() {
        return Ok(AppSettings::with_defaults());
    }
    let json = fs::read_to_string(&path).context("Falha ao ler configurações")?;
    let mut settings: AppSettings = serde_json::from_str(&json)
        .context("Falha ao parsear configurações")
        .or_else(|_| Ok::<AppSettings, anyhow::Error>(AppSettings::with_defaults()))?;

    // Decrypt sensitive fields. On failure (e.g. old plain-text settings),
    // reset field to empty string so the user can re-enter the key.
    settings.openai_api_key =
        crate::crypto::decrypt_string(&settings.openai_api_key).unwrap_or_default();
    settings.groq_api_key =
        crate::crypto::decrypt_string(&settings.groq_api_key).unwrap_or_default();
    settings.openrouter_api_key =
        crate::crypto::decrypt_string(&settings.openrouter_api_key).unwrap_or_default();
    settings.google_cloud_api_key =
        crate::crypto::decrypt_string(&settings.google_cloud_api_key).unwrap_or_default();
    settings.jgrc_session_cookie =
        crate::crypto::decrypt_string(&settings.jgrc_session_cookie).unwrap_or_default();

    Ok(settings)
}
```

- [ ] **Step 5: Run all tests**

```bash
cd src-tauri && cargo test -- --nocapture 2>&1 | tail -20
```

Expected:
```
test crypto::tests::test_empty_string_passthrough ... ok
test crypto::tests::test_encrypt_decrypt_roundtrip ... ok
test crypto::tests::test_invalid_base64_returns_err ... ok
test crypto::tests::test_valid_base64_but_invalid_dpapi_returns_err ... ok
test storage::tests::test_save_load_roundtrip_encrypts_sensitive_fields ... ok
test storage::tests::test_plaintext_keys_in_old_settings_return_empty_on_load ... ok
test text_processing::tests::... ok  (existing tests)

test result: ok. N passed; 0 failed
```

- [ ] **Step 6: Do a full dev build to confirm the app still compiles**

```bash
cd .. && cargo tauri dev 2>&1 | head -40
```

Expected: Tauri app starts without errors. Open Settings, enter an API key, save. Close and reopen Settings — the key should still appear.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/storage/mod.rs
git commit -m "feat(storage): encrypt sensitive settings fields with DPAPI before writing to disk"
```
