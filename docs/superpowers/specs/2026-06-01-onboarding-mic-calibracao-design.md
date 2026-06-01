# Onboarding com seleção de mic + melhorias na calibragem — Design Spec

## Goal

Melhorar a UX de configuração de microfone em dois pontos:

1. **Onboarding** — adicionar um passo dedicado de seleção de microfone no `SetupWizard`, com texto educativo sobre a importância da calibragem e CTA opcional para calibrar imediatamente.
2. **Calibragem** — corrigir três dores concretas no `MicCalibrationWizard`:
   - Falsa falha "muito baixo" mesmo quando o usuário grita (algoritmo decide com base só em RMS, ignorando ganho de hardware do device).
   - Feedback visual em tempo real fraco (barra "sobe e desce" sem comunicar se o nível está no alvo).
   - Resumo final sem explicar **o que mudou** vs. **por quê**, e sem métrica concreta de qualidade.

---

## Architecture

Quatro mudanças, em ordem do mais isolado pro mais transversal:

| # | Mudança | Tipo | Arquivos |
|---|---|---|---|
| 1 | Novo passo "Seu microfone" no onboarding | Frontend novo | `SetupWizard.tsx` |
| 2 | Fix do algoritmo `compute_calibration` + diagnóstico de mic mudo | Rust | `commands.rs` |
| 3 | Novo `CalibrationLevelMeter` (substitui `MicLevelMeter` dentro do wizard) | Frontend + Rust (payload do evento) | `MicCalibrationWizard.tsx`, `commands.rs`, `audio/mod.rs` |
| 4 | Resumo final reescrito em 3 blocos (precisão + diff + porquê) | Frontend | `MicCalibrationWizard.tsx` |

Sem novos comandos Tauri. Apenas mudança de comportamento em comandos existentes (`compute_calibration`) e de payload em evento existente (`mic-test-level`).

---

## Seção 1 — Novo passo "Seu microfone" no onboarding

### Posição no fluxo

Inserir entre **API Key** e **JGRC** no `SetupWizard.tsx`. Total de passos passa de 5 para 6.

```
0. Boas-vindas
1. Tour
2. API Key
3. Seu microfone        ← NOVO
4. JGRC
5. Pronto
```

`TOTAL_STEPS = 6`. O `StepIndicator` e a progress bar derivam do total.

### Conteúdo da tela

- **Título**: "Seu microfone"
- **Subtítulo**: "Escolha o microfone que você usa nas reuniões."
- **Dropdown de microfones**: lista carregada via `invoke<AudioDevice[]>("list_microphones")` no mount do step. Selected default = `"Microfone padrão do sistema"` (primeiro item da lista, `id: ""`).
- **Caixa-aviso informativa** (não bloqueante):
  > 💡 **Calibrar seu microfone melhora muito a transcrição** — o app aprende seu volume normal e o ruído do seu ambiente. Você pode calibrar agora ou depois em **Configurações → Calibrar microfone**.
- **Dois CTAs**:
  - **"Calibrar agora"** (secundário, outline): abre o `MicCalibrationWizard` por cima do `SetupWizard` sem fechar o onboarding. Ao fechar a calibragem (com sucesso ou cancelamento), retorna ao passo "Seu microfone". Se foi calibrado com sucesso, avança automaticamente para JGRC.
  - **"Calibrar depois"** (primário, mesmo estilo do "Próximo" atual): avança pro próximo passo sem calibrar.

### Comportamento

- Ao mudar o dropdown, salva imediatamente em `settings.selected_microphone` via `saveSettings` (mesmo padrão do `SettingsModal`).
- O footer mostra "Pular →" igual aos passos 2 (API Key) e 4 (JGRC). `canSkip` inclui o passo 3.
- O passo "Pronto" (último) ganha duas linhas extras no `ConfigItem` list:
  - **"Microfone"** — nome do device selecionado.
  - **"Calibração"** — `"Concluída"` se rodou, `"Pendente"` em cinza caso contrário.
- Estado novo no componente: `calibrated: boolean`, alimentado pelo callback de sucesso do `MicCalibrationWizard`.

### Trade-offs

- Onboarding fica 1 passo mais longo. Aceitável: usuários que não querem podem pular em 1 clique.
- O `MicCalibrationWizard` precisa aceitar uma prop `onComplete?: () => void` que dispara só quando calibragem terminou com sucesso (não em cancel). Hoje só chama `onClose`. Trivial.

---

## Seção 2 — Fix do algoritmo de calibragem

### Problema

Em `commands.rs::compute_calibration` a regra atual é:

```rust
} else if speech_rms < 0.02 {
    (false, Some("Microfone muito baixo — fale mais alto..."))
}
```

`speech_rms` é fortemente dependente do **ganho de hardware** do device (Windows mic boost, sensibilidade física do mic). Mics dinâmicos ou com boost desligado podem ficar em RMS=0.005 mesmo com o usuário gritando — o sistema deveria compensar com `gain_max` em vez de bloquear.

### Nova lógica de pass/fail

Ordem de avaliação:

| Critério | Condição | Resultado |
|---|---|---|
| 1. Mic mudo | `speech_peak < 0.005` | **Falha**: `"Mic_Mute"` |
| 2. Clipping | `speech_peak > 0.95` | **Falha**: `"Clipping"` |
| 3. SNR ruim + ruído audível | `snr < 6.0` && `silence_rms > 0.005` | **Falha**: `"Noise"` |
| 4. Caso contrário | — | **Sucesso** (gain_max compensa) |

```rust
let (round_passed, failure_reason) = if speech_peak < 0.005 {
    (false, Some("Mic_Mute"))
} else if speech_peak > 0.95 {
    (false, Some("Clipping"))
} else if snr < 6.0 && silence_rms > 0.005 {
    (false, Some("Noise"))
} else {
    (true, None)
};
```

`failure_reason` deixa de ser uma string PT-BR pronta e passa a ser um **código** (`"Mic_Mute"`, `"Clipping"`, `"Noise"`). O frontend mapeia código → mensagem (permite UI diferente por código, ex: dropdown embutido no caso "Mic_Mute").

### Novo range do gain_max

Hoje `(0.18 / speech_rms).clamp(1.5, 8.0)`. Sobe o teto pra cobrir mics com ganho de hardware baixo:

```rust
let gmax = (0.18 / speech_rms.max(0.001)).clamp(1.5, 12.0);
```

Justificativa: o `AutomaticGainControl` em `audio/agc.rs` já tem soft-limiter — amplificar até 12× não causa clipping audível.

### Diagnóstico novo: caso "Mic_Mute"

No frontend, quando `failure_reason == "Mic_Mute"`, em vez do banner genérico "tente de novo", a tela mostra:

```
🔇 Seu microfone não está captando som.

Verifique:
▸ Está usando o microfone certo?
  Selecionado: "Headset USB Logitech"
  [▼ Trocar microfone]               ← dropdown embutido

▸ O volume do microfone no Windows pode estar muito baixo.
  [Abrir painel de som do Windows]   ← link
```

- O **dropdown embutido** lista `list_microphones()` e salva `selected_microphone` imediatamente. Ao trocar, oferece botão "Tentar de novo" que reinicia o round.
- "Abrir painel de som" chama `tauri::plugin::shell::open` com `ms-settings:sound`. Se falhar (Tauri sem permission), mostra fallback: "Painel de Controle → Som → Gravação".

### Mapeamento de códigos → mensagens

| Código | Mensagem PT-BR mostrada no banner |
|---|---|
| `Mic_Mute` | (UI especial acima) |
| `Clipping` | "Você está muito perto do microfone. Recue um pouco e tente novamente." |
| `Noise` | "Muito ruído de fundo — tente se afastar de fontes de ruído ou aproximar o microfone." |

Round 3 sempre finaliza (mantém comportamento atual). Exceção: round 3 + `Mic_Mute` NÃO finaliza — não faz sentido aplicar uma calibração de mic morto. Mostra mensagem e oferece "Trocar mic" / "Cancelar".

### Trade-off

Aceitar SNR aceitável "sempre" pode produzir calibragem mediana em ambiente realmente barulhento. Mitigado pela próxima etapa do wizard (teste de transcrição com frase fixa) — se a precisão der ruim, o usuário vê e pode refazer. Falha falsa por baixo volume **não acontece mais**.

---

## Seção 3 — Feedback em tempo real

### Componente novo: `CalibrationLevelMeter`

Substitui `MicLevelMeter` **somente dentro do `MicCalibrationWizard`**. O `MicLevelMeter` continua existindo pros demais usos (`MicTester` em `SettingsModal`).

Props:
```ts
{
  mode: "speech" | "silence";   // controla a inversão do header
  durationSecs: number;         // seed do contador regressivo (5, 3 ou 6)
}
```

O componente assina o evento `mic-test-level` no mount e cancela no unmount. O contador regressivo é interno (não vem do backend).

### Layout

```
┌───────────────────────────────────────────────────────┐
│  ●  Captando fala ✓                    Gravando 3s   │
├───────────────────────────────────────────────────────┤
│                                                       │
│  ░░░░│█████████████████████│░░░░░░░░░░░░░░░░░░░░░░  │
│      ↑ baixo     ↑ ideal              ↑ muito alto   │
│                                                       │
│  ━━━━━━━━━━━ RMS médio (━━━━━ pico)                  │
└───────────────────────────────────────────────────────┘
```

### Elementos visuais

1. **Faixa colorida estática** (background do meter): vermelho de 0 a 0.04, verde de 0.04 a 0.7, vermelho de 0.7 a 1.0. Sempre visível. Não muda durante a gravação.
2. **Ponteiro de pico instantâneo** — linha vertical fina (2px), vermelho-vivo, posicionada em `peak` recebido a cada evento. Atualiza ~20Hz (50ms server-side).
3. **Ponteiro de RMS médio acumulado** — linha vertical mais grossa (4px), ciano. Posicionada em uma média com decaimento exponencial calculada no frontend: `avg = avg * 0.85 + rms * 0.15`. Mostra "onde está em média", filtra flutuação por sílaba.
4. **Header — indicador de fala**: bolinha + texto, dois estados:
   - **● Aguardando fala...** — cinza, antes de detectar voz.
   - **● Captando fala ✓** — verde piscante, ativa quando RMS instantâneo passou de 0.02 nos últimos 500ms (sliding window mantida em ref do componente).
5. **Contador regressivo** — canto direito do header. Decrementa de N até 0 com base num timer iniciado quando o step entra em recording.

### Inversão para a fase de silêncio

No passo `silence-recording`, o header inverte a lógica:
- **● Silêncio ✓** — verde, quando RMS < 0.01.
- **● Detectando som...** — amarelo, quando RMS >= 0.01 (ruído atrapalha a calibração).

Mensagem visual reforça que **nesse passo o objetivo é silêncio**, ao contrário do passo anterior.

### Mudança no payload do evento `mic-test-level`

Hoje é um `f32` (RMS). Passa a ser objeto:

```rust
let _ = app.emit("mic-test-level", serde_json::json!({
    "rms": level,
    "peak": peak_in_window,
}));
```

`peak_in_window` calculado em `audio/mod.rs::start_capture` (mic thread) — é o `max(samples.abs())` do último buffer processado, mantido até a próxima emissão.

### Compatibilidade com `MicTester` (SettingsModal)

O `MicTester` também escuta `mic-test-level` e recebe um `f32` hoje. Ajuste pequeno: ler `e.payload.rms` em vez de `e.payload`. Sem mudança visual no `MicTester`.

### Usos do componente

Substitui `MicLevelMeter` em 3 telas do wizard:
- `speech-recording` (5s de fala)
- `silence-recording` (3s de silêncio, header invertido)
- `transcription-recording` (6s de leitura da frase, header igual ao de fala)

`LevelZoneHint` (texto abaixo do meter no estado atual) é removido — o feedback agora é todo visual contínuo.

---

## Seção 4 — Resumo final reescrito

### Layout em 3 blocos

```
┌─────────────────────────────────────────────────────┐
│ ✓ Microfone configurado                             │
│                                                     │
│   Precisão estimada: 92%                            │
│   (14 de 15 palavras transcritas corretamente       │
│    no teste de leitura)                             │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ O que mudou                                         │
│                                                     │
│ ▸ Amplificação automática     Desligada  → Ligada   │
│ ▸ Ganho máximo                4.0×       → 7.5×     │
│ ▸ Corte de silêncio           0.003      → 0.008    │
│ ▸ Filtro de ruído             Escritório → Sala...  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Por que essas mudanças                              │
│                                                     │
│ Seu microfone estava captando volume baixo em       │
│ relação ao ideal. Agora ele será amplificado        │
│ automaticamente para ficar no nível certo, sem      │
│ você precisar gritar.                               │
│                                                     │
│ Como o ambiente tem algum ruído de fundo, ajustamos │
│ o filtro para sala barulhenta — ele vai cortar os   │
│ sons fracos entre falas.                            │
└─────────────────────────────────────────────────────┘

  [ Descartar ]              [ Aplicar configurações ]
```

Substitui o componente `SummaryDiff` em `MicCalibrationWizard.tsx` por essa estrutura.

### Bloco 1 — Precisão estimada

- **Fonte**: `transcription.similarity` (já calculado no comando `test_mic_transcription_phrase`).
- **Formato**:
  - Percentual: `Math.round(similarity * 100)%`
  - Subtítulo: `"X de Y palavras transcritas corretamente no teste de leitura"`, onde:
    - `Y = 15` (palavras da frase fixa, hardcoded)
    - `X = Math.round(similarity * Y)`
- **Cor**: emerald se ≥85%, amber se 60–84%, red se <60%.

### Bloco 2 — Antes → depois

Lista cada campo que mudou. Esconde linhas inalteradas. Se nada mudou, mostra: *"Suas configurações já estavam ótimas — nenhuma alteração necessária"* (e o bloco 3 some).

Mapping (linha = label + valor antes + valor depois):

| Campo | Label | Formato do valor |
|---|---|---|
| `mic_auto_gain` | "Amplificação automática" | `Ligada` / `Desligada` |
| `mic_gain_max` | "Ganho máximo" | `{x.x}×` |
| `mic_silence_threshold` | "Corte de silêncio" | 4 casas decimais |
| `noise_gate_preset` | "Filtro de ruído" | `Ambiente silencioso` / `Escritório` / `Sala barulhenta` |

Detecção de mudança em `mic_silence_threshold`: considera mudança se `|new - current| > 0.0005` (mesma tolerância de hoje).

### Bloco 3 — Por que essas mudanças

Gerado client-side por regras simples. Concatena 1–3 frases. Se nenhuma regra dispara, o bloco some.

```
SE mic_auto_gain ligou OU (gain_max aumentou em > 2×):
  "Seu microfone estava captando volume baixo em relação ao
   ideal. Agora ele será amplificado automaticamente para ficar
   no nível certo, sem você precisar gritar."

SENÃO SE gain_max diminuiu:
  "Seu microfone estava captando volume alto demais. Reduzimos a
   amplificação pra evitar distorção."

SE noise_gate_preset mudou para "auditorium":
  "Como o ambiente tem ruído de fundo perceptível, ajustamos o
   filtro pra sala barulhenta — ele vai cortar sons fracos entre
   falas."

SENÃO SE noise_gate_preset mudou para "silent":
  "Seu ambiente está bem silencioso, então removemos quase todo
   o filtro de ruído pra captar até falas baixas."

SE mic_silence_threshold mudou em > 50% (relativo ao valor atual):
  "Ajustamos o corte de silêncio pro nível de ruído do seu
   ambiente — chunks silenciosos serão descartados antes da
   transcrição (economiza chamadas de API)."
```

### Caso especial: teste de transcrição pulado

Se o usuário escolheu "Continuar mesmo assim" após o teste falhar, o Bloco 1 mostra:

> ⚠️ Calibração aplicada sem teste de precisão.
> Recomendamos refazer o teste em ambiente mais silencioso quando possível.

Bloco 2 e 3 aparecem normalmente.

### Trade-off

Regras client-side são frágeis a edge cases (ex: ganho aumentou um pouco mas não passou de 2×). Mitigado por escolher thresholds com margem confortável — em geral, mudanças significativas disparam pelo menos uma regra. Se nenhuma disparar, o Bloco 3 some inteiro (não fica vazio nem com placeholder).

---

## Mudanças por arquivo

| Arquivo | Mudança |
|---|---|
| `src/components/SetupWizard.tsx` | Novo passo 3 ("Seu microfone"). `TOTAL_STEPS = 6`. Atualiza `canSkip`, dots, e o resumo final. |
| `src/components/MicCalibrationWizard.tsx` | Aceita `onComplete?` prop. Substitui `SummaryDiff` por 3 blocos. Substitui `MicLevelMeter` por `CalibrationLevelMeter`. Adiciona UI especial pro caso `Mic_Mute` (dropdown embutido + link de som). |
| `src/components/CalibrationLevelMeter.tsx` | **Novo**. Faixa colorida + 2 ponteiros + header com 2 estados + contador. |
| `src-tauri/src/commands.rs` | Reescreve regras de `compute_calibration` (nova lógica de pass/fail). Sobe gain_max max para 12.0. Muda payload de `mic-test-level` pra `{rms, peak}` no `test_mic_with_transcription` e `record_calibration_phase`. |
| `src-tauri/src/audio/mod.rs` | Track de `peak_in_window` no mic thread para o novo payload do evento (uma `Mutex<f32>` em `AudioCaptureState`). |
| `src/components/SettingsModal.tsx` (MicTester) | Ajuste mínimo: ler `e.payload.rms` em vez de `e.payload` direto. |

---

## Out of scope

- **Perfis de calibragem por microfone** (lembrar calibragem por device). Útil mas é Abordagem 3 — fica pra depois.
- **Detecção automática de gain do Windows** (ler o registry/IAudioEndpointVolume pra ler/setar o volume do mic). Risco de mexer em configuração do SO; o caminho atual ("abrir painel de som") é mais conservador.
- **Hot-plug detection** (detectar mic plugado/desplugado durante a calibração). Comportamento hoje (timeout / falha) é aceitável.
- **macOS/Linux**: tudo WASAPI, escopo Windows.
- **Renomear o evento `mic-test-level`** pra deixar mais claro. Manter o nome reduz churn — só muda o payload.
