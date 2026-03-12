# JGP Meeting — Guia de Instalação e Uso

## Visão Geral

O **JGP Meeting** é um aplicativo desktop que escuta o áudio do seu computador durante reuniões (Zoom, Google Meet, Teams, etc.), transcreve automaticamente o conteúdo e gera um resumo inteligente usando IA.

**Funcionamento:** O app captura o áudio do sistema via WASAPI Loopback (Windows) — o mesmo som que sai pelo seu alto-falante ou fone de ouvido — sem precisar entrar diretamente na chamada.

---

## Requisitos

| Dependência | Versão mínima | Link |
|---|---|---|
| Windows | 10 ou 11 | — |
| Rust + Cargo | 1.70+ | https://rustup.rs |
| Node.js | 18+ | https://nodejs.org |
| Chave API OpenAI | — | https://platform.openai.com |

### Instalar Tauri CLI

```bash
cargo install tauri-cli
```

---

## Instalação

### 1. Clonar / abrir o projeto

```bash
cd jgp-meeting
```

### 2. Instalar dependências Node.js

```bash
npm install
```

### 3. Configurar a chave da API

Abra o aplicativo, vá em **Configurações** e insira sua chave da OpenAI (`sk-...`).

Ela é armazenada localmente em `%APPDATA%\jgp-meeting\settings.json`.

---

## Rodar em modo desenvolvimento

```bash
npm run tauri dev
```

Este comando:
1. Inicia o servidor Vite (React) na porta 1420
2. Compila o backend Rust
3. Abre a janela do aplicativo

---

## Build para produção

```bash
npm run tauri build
```

Gera um instalador `.msi` e o executável em `src-tauri/target/release/`.

### Ícones (necessário para build)

Antes de fazer o build, gere os ícones com:

```bash
npm run tauri icon assets/icon.png
```

(Crie um PNG 1024x1024 com o logo do app)

---

## Como usar

1. **Configure** sua chave OpenAI nas Configurações
2. Inicie uma reunião no Zoom/Meet/Teams normalmente
3. Clique em **Start Listening** no JGP Meeting
4. A transcrição aparece em tempo real na tela
5. Ao terminar, clique em **Stop Listening**
6. Clique em **Gerar Resumo** para obter o resumo com decisões e tarefas
7. Acesse o **Histórico** para ver reuniões passadas

---

## Arquitetura

```
jgp-meeting/
├── src/                      # Frontend React + TypeScript
│   ├── components/           # Componentes UI reutilizáveis
│   ├── hooks/                # Hooks de estado (captura, transcrição, histórico)
│   ├── pages/                # Páginas da aplicação
│   ├── services/             # Interfaces para os comandos Tauri
│   └── types/                # Tipos TypeScript compartilhados
│
└── src-tauri/src/            # Backend Rust
    ├── audio/                # WASAPI loopback (captura de áudio do sistema)
    ├── transcription/        # Cliente da API Whisper
    ├── ai/                   # Geração de resumo via GPT
    ├── storage/              # Persistência local (JSON)
    └── commands.rs           # Comandos Tauri expostos ao frontend
```

### Fluxo de dados

```
Sistema de Áudio
    ↓ (WASAPI Loopback)
audio/mod.rs → chunks de áudio (PCM f32)
    ↓ (WAV encoding via hound)
transcription/mod.rs → API Whisper
    ↓ (texto transcrito)
Evento Tauri → React (TranscriptionPanel)
    ↓ (usuário clica "Gerar Resumo")
ai/mod.rs → API GPT-4o-mini
    ↓ (JSON estruturado)
React (SummaryPanel) → cards com resumo, decisões, tarefas
    ↓
storage/mod.rs → %APPDATA%/jgp-meeting/meetings/*.json
```

---

## Configurações disponíveis

| Configuração | Padrão | Descrição |
|---|---|---|
| Chave API OpenAI | — | Necessária para Whisper + GPT |
| Idioma da transcrição | `pt` | Código de idioma para Whisper |
| Modelo GPT | `gpt-4o-mini` | Modelo para geração de resumos |
| Intervalo de transcrição | `10s` | Frequência de envio de chunks |

---

## Problemas comuns

### "Chave da API OpenAI não configurada"
→ Acesse Configurações e insira sua chave `sk-...`

### "Falha ao obter dispositivo de áudio padrão"
→ Verifique se há um dispositivo de saída de áudio ativo no Windows

### Transcrição vazia / "áudio silencioso"
→ Verifique se o áudio da reunião está sendo reproduzido pelo computador (não via fones Bluetooth separados)

### Erro de compilação Rust
→ Execute `rustup update` para atualizar o Rust

---

## Custos de API (estimativa)

| Recurso | Custo OpenAI |
|---|---|
| Transcrição (Whisper) | ~$0.006/minuto |
| Resumo (GPT-4o-mini) | ~$0.001 por reunião típica |
| Reunião de 1h | ~$0.40 total |
