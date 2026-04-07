// src-tauri/src/crypto.rs
// Wrappers over Windows DPAPI (CryptProtectData / CryptUnprotectData).
// Encrypts/decrypts UTF-8 strings; encrypted form is base64-encoded DPAPI blob.

#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD, Engine};

#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
            CRYPTPROTECT_PROMPTSTRUCT,
        },
    },
};

/// Encrypts `plaintext` with DPAPI, returns base64-encoded ciphertext.
/// Empty input returns empty string without calling DPAPI.
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
            None,
            None,
            None::<*const CRYPTPROTECT_PROMPTSTRUCT>,
            0u32,
            &mut output_blob,
        )
        .map_err(|e| format!("DPAPI encrypt failed: {e}"))?;

        let encrypted: Vec<u8> =
            std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize)
                .to_vec();

        let _ = LocalFree(HLOCAL(output_blob.pbData as *mut std::ffi::c_void));

        Ok(STANDARD.encode(&encrypted))
    }
}

/// Decrypts a base64-encoded DPAPI blob back to plaintext.
/// Empty input returns empty string without calling DPAPI.
/// Returns `Err` on invalid base64 or DPAPI failure.
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
            None,
            None,
            None,
            None::<*const CRYPTPROTECT_PROMPTSTRUCT>,
            0u32,
            &mut output_blob,
        )
        .map_err(|e| format!("DPAPI decrypt failed: {e}"))?;

        let plaintext_bytes: Vec<u8> =
            std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize)
                .to_vec();

        let _ = LocalFree(HLOCAL(output_blob.pbData as *mut std::ffi::c_void));

        String::from_utf8(plaintext_bytes).map_err(|e| format!("UTF-8 decode failed: {e}"))
    }
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
