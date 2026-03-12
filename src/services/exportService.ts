// services/exportService.ts — Feature 4
import { invoke } from '@tauri-apps/api/core';

export type ExportFormat = 'txt' | 'md';

/** Exporta uma reunião e retorna o caminho do arquivo criado. */
export async function exportMeeting(meetingId: string, format: ExportFormat): Promise<string> {
  return invoke<string>('export_meeting', { meetingId, format });
}

/** Abre a pasta de exportações no explorador do sistema. */
export async function openExportFolder(): Promise<void> {
  return invoke('open_export_folder');
}
