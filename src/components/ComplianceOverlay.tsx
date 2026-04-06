// ComplianceOverlay.tsx
// Badge flutuante always-on-top exibido durante a gravação.
// Renderizado em uma janela Tauri separada (label: "compliance") — transparente,
// sem decorações, sempre visível sobre as outras janelas.
// Durante compartilhamento de tela os participantes podem ver este aviso.

import { useLayoutEffect } from "react";

export const ComplianceOverlay = () => {
  // Força fundo transparente para que apenas o badge seja visível.
  // Precisa rodar antes do primeiro paint (useLayoutEffect).
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("background", "transparent", "important");
    document.body.style.setProperty("background", "transparent", "important");
    // Remove qualquer classe de tema do html/body que possa adicionar fundo
    document.documentElement.className = "";
    document.body.className = "";
  }, []);

  return (
    <div
      className="flex items-start justify-start w-screen h-screen"
      style={{ background: "transparent" }}
    >
      {/* Badge de gravação */}
      <div
        className="flex items-center gap-2.5 m-2 px-3.5 py-2.5 rounded-xl shadow-2xl select-none cursor-default"
        style={{
          background: "rgba(220, 38, 38, 0.92)",
          backdropFilter: "blur(8px)",
          border: "1px solid rgba(239, 68, 68, 0.5)",
          WebkitAppRegion: "drag",
        } as React.CSSProperties}
      >
        {/* Indicador pulsante */}
        <div className="relative flex items-center justify-center w-3 h-3 flex-shrink-0">
          <span
            className="absolute inline-flex w-full h-full rounded-full opacity-75 animate-ping"
            style={{ background: "rgba(255,255,255,0.8)" }}
          />
          <span
            className="relative inline-flex rounded-full w-2.5 h-2.5"
            style={{ background: "white" }}
          />
        </div>

        {/* Texto */}
        <div className="leading-tight">
          <p
            className="text-xs font-bold tracking-widest"
            style={{ color: "white", lineHeight: 1 }}
          >
            GRAVANDO
          </p>
          <p
            className="text-[10px] mt-0.5"
            style={{ color: "rgba(254, 202, 202, 1)", lineHeight: 1 }}
          >
            Reunião sendo transcrita
          </p>
        </div>
      </div>
    </div>
  );
};
