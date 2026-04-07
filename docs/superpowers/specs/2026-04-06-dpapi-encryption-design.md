# Design: DPAPI Encryption for Sensitive Settings Fields

**Date:** 2026-04-06  
**Status:** Approved

## Problem

API keys and the JGRC session cookie are stored in plain text in `%APPDATA%\Local\jgp-meeting\settings.json`. Any process with access to the user's AppData directory can read them.

## Goal

Encrypt the 5 sensitive fields at rest using the Windows Data Protection API (DPAPI), with no changes to the frontend or Tauri command layer.

## Scope

**In scope:**
- Encrypt 5 fields in `AppSettings` before writing to disk
- Decrypt those fields after reading from disk
- Handle decryption failure gracefully (return `""`, user re-enters key)

**Out of scope:**
- Migration of existing plain-text `settings.json` (reset behavior: old keys become blank on first load after update)
- Key rotation
- Audit logging
- Cross-platform support (app is Windows-only)

## Sensitive Fields

| Field | Struct path |
|---|---|
| `openai_api_key` | `AppSettings.openai_api_key` |
| `groq_api_key` | `AppSettings.groq_api_key` |
| `openrouter_api_key` | `AppSettings.openrouter_api_key` |
| `google_cloud_api_key` | `AppSettings.google_cloud_api_key` |
| `jgrc_session_cookie` | `AppSettings.jgrc_session_cookie` |

Empty strings (`""`) are stored as-is without encryption.

## Architecture

No changes to the frontend or Tauri command layer. All logic is in the Rust backend.

```
Frontend (React)
    ↓ invoke("save_settings") / invoke("get_settings")
commands.rs  ← unchanged
    ↓
storage/mod.rs  ← MODIFIED: encrypt on save, decrypt on load
    ↓
crypto.rs  ← NEW: DPAPI wrappers
    ↓
Windows CryptProtectData / CryptUnprotectData
```

`AppSettings` remains plain-text strings in memory. The transformation happens only at the boundary between memory and disk.

## New File: `src-tauri/src/crypto.rs`

Two public functions:

```rust
/// Encrypts a plaintext string using DPAPI. Returns base64-encoded ciphertext.
/// Returns Err if the Windows API call fails.
pub fn encrypt_string(plaintext: &str) -> Result<String, String>

/// Decrypts a base64-encoded DPAPI blob. Returns the original plaintext.
/// Returns Err if decoding or decryption fails (e.g., wrong user, corrupted data).
pub fn decrypt_string(encoded: &str) -> Result<String, String>
```

Implementation uses `CryptProtectData` and `CryptUnprotectData` from the `windows` crate. The encrypted output is `base64::encode(dpapi_output_blob)`.

## Changes to `src-tauri/Cargo.toml`

Add under `[target.'cfg(windows)'.dependencies]`:

```toml
windows = { version = "0.58", features = [
  "Win32_Security_Cryptography",
  "Win32_Foundation",
  "Win32_System_Memory"
]}
```

The `base64` crate (version `0.22`) is already present — no new dependency needed for encoding.

## Changes to `src-tauri/src/storage/mod.rs`

### `save_settings(settings: &AppSettings)`

Before serializing, clone `AppSettings` and replace the 5 sensitive fields with their encrypted base64 values. If encryption of any field fails, return an error — do not write a partially-protected file.

```
AppSettings (plain) → encrypt 5 fields → StorableSettings (encrypted) → serde_json → disk
```

### `load_settings()`

After deserializing from JSON, attempt to decrypt each of the 5 sensitive fields. If decryption fails for a field (invalid base64, DPAPI error, or empty string), set the field to `""` — do not propagate the error. Return the resulting `AppSettings` with decrypted values.

```
disk → serde_json → AppSettings (encrypted fields) → decrypt 5 fields → AppSettings (plain)
```

## Reset Behavior

On first launch after update, `load_settings()` will fail to decrypt the old plain-text values. Each affected field silently becomes `""`. The user will see empty API key inputs in the Settings modal and must re-enter them. No explicit error or migration dialog is shown.

## Error Handling

| Scenario | Behavior |
|---|---|
| Encryption fails on save | `save_settings` returns `Err`, settings not written |
| Decryption fails on load | Field set to `""`, load continues |
| Field is `""` on save | Written as `""`, not encrypted |
| Field is `""` on load | Returned as `""`, no decryption attempted |

## Testing

- Unit test `encrypt_string` → `decrypt_string` round-trip in `crypto.rs`
- Unit test `decrypt_string` with invalid base64 input returns `Err`
- Unit test `load_settings` with a JSON containing plain-text keys returns empty strings for those fields
- Unit test `save_settings` → `load_settings` round-trip preserves all non-sensitive fields and the 5 sensitive fields
