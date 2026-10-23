import { app } from './state.js';
import { toast } from './dom.js';
import { buildBackup, backupJSON } from '../io/backup.js';
import { downloadText, stampForFile } from '../io/download.js';

export const DEFAULT_LOGO = 'assets/logo.png';
export const logoSrc = () => app.settings?.logo?.dataUrl || DEFAULT_LOGO;

// Sidebar brand: the "EP" mark + "Engineered Plans / Project Tracker" by default; a custom logo (Settings) replaces the
// mark and name, falling back to them if the image cannot be loaded.
export function applyHeaderLogo() {
  const img = document.getElementById('brand-logo');
  const mark = document.getElementById('brand-mark');
  const txt = document.getElementById('brand-text');
  const custom = app.settings?.logo?.dataUrl;
  const showDefault = () => { img.hidden = true; mark.hidden = false; txt.hidden = false; };
  if (!custom) { showDefault(); return; }
  img.onerror = showDefault;
  img.src = custom;
  img.hidden = false; mark.hidden = true; txt.hidden = true;
}

export async function exportBackupNow() {
  try {
    const b = await buildBackup(app.db);
    const name = `engineeredplans-tracker-backup_${app.mode === 'demo' ? 'DEMO_' : ''}${stampForFile()}.json`;
    downloadText(name, backupJSON(b));
    const now = new Date().toISOString();
    await app.db.setMeta('lastBackupAt', now);
    app.lastBackupAt = now;
    toast(`Backup file “${name}” sent to your browser's downloads. Keep a copy somewhere safe (e.g. another drive).`, 'ok', 7000);
    return true;
  } catch (e) {
    toast('Backup failed: ' + e.message, 'error', 8000);
    return false;
  }
}
