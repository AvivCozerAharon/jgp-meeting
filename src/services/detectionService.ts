// services/detectionService.ts — Feature 12
import { invoke } from '@tauri-apps/api/core';
import type { DetectedApp } from '../types';

/** Verifica quais apps de reunião estão em execução no sistema. */
export async function checkMeetingApps(): Promise<DetectedApp[]> {
  return invoke<DetectedApp[]>('check_meeting_apps');
}
