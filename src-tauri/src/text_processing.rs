// text_processing.rs — Normalização de números falados em português.
//
// Converte padrões de fala transcritos para forma numérica compacta.
// Exemplos:
//   "vinte e cinco por cento"       → "25%"
//   "dois vírgula cinco por cento"  → "2,5%"
//   "três bilhões"                  → "3 bilhões"
//   "primeiro trimestre"            → "1º trimestre"

use once_cell::sync::Lazy;
use regex::Regex;

// ── Tabela de palavras numéricas ──────────────────────────────────────────────

fn word_val(s: &str) -> Option<u64> {
    match s.trim() {
        "zero"                          => Some(0),
        "um"   | "uma"                  => Some(1),
        "dois" | "duas"                 => Some(2),
        "três" | "tres"                 => Some(3),
        "quatro"                        => Some(4),
        "cinco"                         => Some(5),
        "seis"                          => Some(6),
        "sete"                          => Some(7),
        "oito"                          => Some(8),
        "nove"                          => Some(9),
        "dez"                           => Some(10),
        "onze"                          => Some(11),
        "doze"                          => Some(12),
        "treze"                         => Some(13),
        "quatorze" | "catorze"          => Some(14),
        "quinze"                        => Some(15),
        "dezesseis" | "dezasseis"       => Some(16),
        "dezessete" | "dezassete"       => Some(17),
        "dezoito"                       => Some(18),
        "dezenove" | "dezanove"         => Some(19),
        "vinte"                         => Some(20),
        "trinta"                        => Some(30),
        "quarenta"                      => Some(40),
        "cinquenta"                     => Some(50),
        "sessenta"                      => Some(60),
        "setenta"                       => Some(70),
        "oitenta"                       => Some(80),
        "noventa"                       => Some(90),
        "cem"   | "cento"               => Some(100),
        "duzentos"   | "duzentas"       => Some(200),
        "trezentos"  | "trezentas"      => Some(300),
        "quatrocentos" | "quatrocentas" => Some(400),
        "quinhentos" | "quinhentas"     => Some(500),
        "seiscentos" | "seiscentas"     => Some(600),
        "setecentos" | "setecentas"     => Some(700),
        "oitocentos" | "oitocentas"     => Some(800),
        "novecentos" | "novecentas"     => Some(900),
        _                               => None,
    }
}

/// Converte uma expressão numérica em português (0–999) para u64.
/// Exemplos: "vinte e dois" → 22, "cento e cinquenta" → 150.
fn parse_num(s: &str) -> Option<u64> {
    let s = s.trim().to_lowercase();
    let s = s.as_str();

    if let Some(v) = word_val(s) {
        return Some(v);
    }

    // Divide em partes pelo " e " (máx 3 partes: centenas e dezenas e unidades)
    let parts: Vec<&str> = s.splitn(3, " e ").map(str::trim).collect();
    match parts.len() {
        2 => {
            let a = word_val(parts[0])?;
            let b = word_val(parts[1])?;
            if a >= 100 && b < 100 { return Some(a + b); } // cento e X
            if a >= 20  && b < 20  { return Some(a + b); } // vinte e X
            None
        }
        3 => {
            // "cento e vinte e dois" → 100 + 20 + 2
            let a = word_val(parts[0])?;
            let b = word_val(parts[1])?;
            let c = word_val(parts[2])?;
            if a >= 100 && b >= 20 && b < 100 && c < 20 {
                return Some(a + b + c);
            }
            None
        }
        _ => None,
    }
}

// ── Padrões base (alternações regex) ─────────────────────────────────────────

const H: &str = "cem|cento|\
    duzentos|duzentas|trezentos|trezentas|quatrocentos|quatrocentas|\
    quinhentos|quinhentas|seiscentos|seiscentas|setecentos|setecentas|\
    oitocentos|oitocentas|novecentos|novecentas";

const T: &str = "vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa";

const U: &str = "zero|um|uma|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|\
    dez|onze|doze|treze|quatorze|catorze|quinze|\
    dezesseis|dezasseis|dezessete|dezassete|dezoito|dezenove|dezanove";

/// Expressão numérica completa em português (0–999).
/// Alternativas ordenadas da mais longa para a mais curta para garantir match guloso.
static NUM_EXPR: Lazy<String> = Lazy::new(|| {
    format!(
        "(?:\
            (?:{h})\\s+e\\s+(?:{t})\\s+e\\s+(?:{u})|\
            (?:{h})\\s+e\\s+(?:{t}|{u})|\
            (?:{h})|\
            (?:{t})\\s+e\\s+(?:{u})|\
            (?:{t})|\
            (?:{u})\
        )",
        h = H, t = T, u = U,
    )
});

// ── Regexes compiladas ────────────────────────────────────────────────────────

/// "dois vírgula cinco por cento" → "2,5%"
static RE_PCT_DEC: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?i)\b({n})\s+vírgula\s+({n})\s+por\s+cento\b",
        n = *NUM_EXPR
    )).unwrap()
});

/// "vinte e cinco por cento" → "25%"
static RE_PCT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?i)\b({n})\s+(?:por\s+cento|porcento)\b",
        n = *NUM_EXPR
    )).unwrap()
});

/// "dois vírgula cinco" → "2,5"
static RE_DEC: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?i)\b({n})\s+vírgula\s+({n})\b",
        n = *NUM_EXPR
    )).unwrap()
});

/// "três bilhões", "duzentos milhões" → "3 bilhões", "200 milhões"
static RE_MAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?i)\b({n})\s+(mil|milhão|milhões|bilhão|bilhões|trilhão|trilhões)\b",
        n = *NUM_EXPR
    )).unwrap()
});

/// "primeiro trimestre" → "1º trimestre"
static RE_ORD: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(primeiro|primeira|segundo|segunda|terceiro|terceira|quarto|quarta|quinto|quinta|sexto|sexta|s[eé]timo|s[eé]tima|oitavo|oitava|nono|nona|d[eé]cimo|d[eé]cima)\s+(trimestre|semestre|ano|m[eê]s|lugar|posto)\b"
    ).unwrap()
});

fn ordinal_num(word: &str) -> &'static str {
    match word.to_lowercase().as_str() {
        "primeiro"                          => "1º",
        "primeira"                          => "1ª",
        "segundo"                           => "2º",
        "segunda"                           => "2ª",
        "terceiro"                          => "3º",
        "terceira"                          => "3ª",
        "quarto"                            => "4º",
        "quarta"                            => "4ª",
        "quinto"                            => "5º",
        "quinta"                            => "5ª",
        "sexto"                             => "6º",
        "sexta"                             => "6ª",
        w if w.contains("timo")             => "7º",
        w if w.contains("tima")             => "7ª",
        "oitavo"                            => "8º",
        "oitava"                            => "8ª",
        "nono"                              => "9º",
        "nona"                              => "9ª",
        w if w.contains("cimo")             => "10º",
        w if w.contains("cima")             => "10ª",
        _                                   => "?º",
    }
}

// ── Função pública ────────────────────────────────────────────────────────────

/// Normaliza números falados em português no texto de uma transcrição.
///
/// Aplica as seguintes transformações (case-insensitive):
/// 1. `X vírgula Y por cento`  → `X,Y%`
/// 2. `X por cento`            → `X%`
/// 3. `X vírgula Y`            → `X,Y`
/// 4. `X mil/milhões/bilhões`  → `X mil/milhões/bilhões` (com dígitos)
/// 5. `primeiro trimestre`     → `1º trimestre` (e similares)
pub fn normalize_numbers(text: &str) -> String {
    // Passo 1: percentual decimal
    let s = RE_PCT_DEC.replace_all(text, |caps: &regex::Captures| {
        let int_p = parse_num(&caps[1]).map(|n| n.to_string()).unwrap_or_else(|| caps[1].to_string());
        let dec_p = parse_num(&caps[2]).map(|n| n.to_string()).unwrap_or_else(|| caps[2].to_string());
        format!("{},{}%", int_p, dec_p)
    }).into_owned();

    // Passo 2: percentual simples
    let s = RE_PCT.replace_all(&s, |caps: &regex::Captures| {
        parse_num(&caps[1])
            .map(|n| format!("{}%", n))
            .unwrap_or_else(|| caps[0].to_string())
    }).into_owned();

    // Passo 3: decimal
    let s = RE_DEC.replace_all(&s, |caps: &regex::Captures| {
        let int_p = parse_num(&caps[1]).map(|n| n.to_string()).unwrap_or_else(|| caps[1].to_string());
        let dec_p = parse_num(&caps[2]).map(|n| n.to_string()).unwrap_or_else(|| caps[2].to_string());
        format!("{},{}", int_p, dec_p)
    }).into_owned();

    // Passo 4: magnitude (mil / milhões / bilhões)
    let s = RE_MAG.replace_all(&s, |caps: &regex::Captures| {
        parse_num(&caps[1])
            .map(|n| format!("{} {}", n, &caps[2]))
            .unwrap_or_else(|| caps[0].to_string())
    }).into_owned();

    // Passo 5: ordinais com contexto
    let s = RE_ORD.replace_all(&s, |caps: &regex::Captures| {
        format!("{} {}", ordinal_num(&caps[1]), &caps[2])
    }).into_owned();

    s
}

// ── Testes ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pct_simples() {
        assert_eq!(normalize_numbers("retorno de vinte e cinco por cento"), "retorno de 25%");
        assert_eq!(normalize_numbers("cem por cento dos casos"),            "100% dos casos");
        assert_eq!(normalize_numbers("dois porcento"),                      "2%");
    }

    #[test]
    fn test_pct_decimal() {
        assert_eq!(normalize_numbers("dois vírgula cinco por cento"), "2,5%");
        assert_eq!(normalize_numbers("vinte e dois vírgula cinco por cento"), "22,5%");
    }

    #[test]
    fn test_decimal() {
        assert_eq!(normalize_numbers("fator de dois vírgula cinco"),      "fator de 2,5");
        assert_eq!(normalize_numbers("índice de um vírgula oito por ano"), "índice de 1,8 por ano");
    }

    #[test]
    fn test_magnitude() {
        assert_eq!(normalize_numbers("três bilhões em ativos"),       "3 bilhões em ativos");
        assert_eq!(normalize_numbers("duzentos milhões de reais"),    "200 milhões de reais");
        assert_eq!(normalize_numbers("cinquenta mil cotistas"),       "50 mil cotistas");
    }

    #[test]
    fn test_ordinais() {
        assert_eq!(normalize_numbers("resultados do primeiro trimestre"), "resultados do 1º trimestre");
        assert_eq!(normalize_numbers("no segundo semestre"),              "no 2º semestre");
        assert_eq!(normalize_numbers("terceiro ano consecutivo"),         "3º ano consecutivo");
    }

    #[test]
    fn test_sem_alteracao() {
        // Não deve alterar texto sem padrões numéricos
        let t = "a reunião foi produtiva";
        assert_eq!(normalize_numbers(t), t);
        // Não deve alterar números já em dígitos
        let t2 = "retorno de 25%";
        assert_eq!(normalize_numbers(t2), t2);
    }
}
