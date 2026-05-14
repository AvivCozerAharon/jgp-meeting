# Compliance Overlay Redesign

**Date:** 2026-05-14  
**Status:** Approved

## Goal

Refinar o compliance overlay para ser mais compacto, com estética macOS, melhor responsividade nos controles e menor custo de performance.

## Shape e Layout

- **Dimensões:** 260×44px (era 340×72px)
- **Layout:** `[logo] | [badge REC/PAUSADO] [timer] | [mic] [pause] [stop]`
- **Border-radius:** 22px — pill completo
- **Fundo:** `rgba(22, 22, 24, 0.82)` + `backdrop-filter: blur(20px) saturate(160%)`
- **Borda:** `1px solid rgba(255,255,255,0.09)`
- **Sombra:** `0 4px 24px rgba(0,0,0,0.35)`
- **Margem:** 10px da borda da tela (mantém atual)
- **Drag:** pill inteiro draggável; botões com `WebkitAppRegion: no-drag`

## Tipografia e Cores

- **Timer:** `"SF Mono", "Cascadia Code", monospace`, 13px, weight 500, `rgba(255,255,255,0.80)`
- **Badge REC:** 10px, weight 600, letter-spacing 0.08em, cor `#ef4444`
- **Badge PAUSADO:** mesma tipografia, cor `#f59e0b`, sem animação
- **Ícones dos botões:** 12px (era 13px)

## Animações

Todas via CSS puro — zero custo de re-render React.

```css
@keyframes rec-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(1.15); }
}
```

Aplicado no dot vermelho do badge REC via className. Quando pausado, animação é removida.

## Botões

- **Tamanho:** 26×26px, `border-radius: 13px` (circulares)
- **Hover:** transição `80ms` (era 150ms)
- **Hover via CSS class** `.ctrl-btn` em `index.css` — sem `onMouseEnter`/`onMouseLeave` inline
- **Estado ativo:** borda e fundo avermelhado (mantém lógica atual)

## Performance

### Optimistic Update nos controles
Mute e pause atualizam o estado local imediatamente antes do invoke retornar:

```ts
const handleMute = () => {
  setMicMuted(v => !v);
  invoke("toggle_mic_mute")
    .then(setMicMuted)
    .catch(() => setMicMuted(v => !v));
};
```

Stop mantém `await` pois é destrutivo.

### Poll reduzido
- Intervalo de poll: 2000ms → 5000ms
- Justificativa: eventos Tauri (`capture-paused`, `recording-stopped`) já cobrem mudanças em tempo real; poll é apenas fallback de consistência

### Hover sem React
- Remover handlers `onMouseEnter`/`onMouseLeave` inline com `element.style` direto
- Substituir por classe CSS `.ctrl-btn` com `:hover` — browser lida sem passar pelo React

## Arquivos Afetados

- `src/components/ComplianceOverlay.tsx` — refino visual e lógica de botões
- `src/index.css` — adicionar bloco `/* compliance overlay */` com animações e `.ctrl-btn`
- `src-tauri/src/commands.rs` — ajustar `inner_size` de `(340.0, 72.0)` para `(260.0, 44.0)`

## Fora de Escopo

- Modo colapsável (hover-to-expand)
- Formato vertical
- Mudanças na lógica de backend (audio, transcription)
