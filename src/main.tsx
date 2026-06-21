import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { currentMonitor, cursorPosition, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import Tesseract from 'tesseract.js';
import { AnnotationEditor, type AnnotationSavePayload } from './annotationEditor';
import {
  Aperture,
  AlertTriangle,
  Brush,
  ChevronRight,
  CheckCircle2,
  Cloud,
  Copy,
  Crosshair,
  Download,
  History,
  Image as ImageIcon,
  Link,
  MoreVertical,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings,
  UploadCloud,
  Users,
  ShieldCheck,
  X,
} from 'lucide-react';
import './styles.css';

type CaptureMode = 'area' | 'fullscreen';
type AppTab = 'capture' | 'history' | 'queue' | 'settings';
type ShortcutField = 'areaShortcut' | 'fullscreenShortcut';
type CaptureDestination = 'local' | 'dendroApi' | 'googleDrive';
type UploadDestination = 'dendroApi' | 'googleDrive';
type SettingsSection = 'destination' | 'local' | 'dendroApi' | 'googleDrive' | 'capture';

interface NativeCapture {
  pngBase64: string;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  scaleFactor: number;
  originX: number;
  originY: number;
  monitors: CaptureMonitor[];
}

interface CaptureMonitor {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

interface MonitorPreview {
  monitor: CaptureMonitor;
  pngBase64: string;
  width: number;
  height: number;
}

interface CaptureRegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CaptureSettings {
  apiBaseUrl: string;
  areaShortcut: string;
  fullscreenShortcut: string;
  qualityScale: number;
  delayedAreaCaptureSeconds: number;
  deviceName: string;
  captureDestination: CaptureDestination;
  apiSendingEnabled: boolean;
  openAfterUpload: boolean;
  hideDuringCapture: boolean;
  liveAreaSelection: boolean;
  saveLocally: boolean;
  googleDriveUploadEnabled: boolean;
  googleDriveOcrEnabled: boolean;
  googleDriveClientId: string;
  googleDriveClientSecret: string;
  launchOnStartup: boolean;
}

interface PendingCapture {
  id: string;
  mode: CaptureMode;
  capturedAt: string;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  scaleFactor: number;
  appName?: string;
  windowTitle?: string;
  previewBase64?: string;
  destination?: UploadDestination;
  assetUrl?: string;
  googleDriveFileId?: string;
  googleDriveUrl?: string;
  googleDriveFolderUrl?: string;
}

type UploadableCapture = PendingCapture & { pngBase64?: string };

interface LocalCapture extends PendingCapture {
  filePath?: string;
}

type EditingCaptureSource = 'latest' | 'history' | 'queue';

interface EditingCapture {
  source: EditingCaptureSource;
  item: LocalCapture;
  imageBase64: string;
  title: string;
}

interface LocalCaptureSave {
  filePath: string;
}

interface GoogleDriveStatus {
  configured: boolean;
  linked: boolean;
  hasClientSecret?: boolean;
  clientId?: string | null;
  email?: string | null;
  folderId?: string | null;
  folderName?: string | null;
}

interface GoogleDriveLinkResult {
  email?: string | null;
  folderId: string;
  folderName: string;
}

interface GoogleDriveUploadResult {
  fileId: string;
  webViewLink?: string | null;
  folderViewLink?: string | null;
  ocrIndexed: boolean;
}

interface GoogleDriveOcrUpdateResult {
  ocrIndexed: boolean;
}

interface CaptureWindowContext {
  appName?: string | null;
  windowTitle?: string | null;
}

interface DeviceState {
  deviceId: string;
  publicKey: string;
}

interface AreaCaptureSession {
  width: number;
  height: number;
  scaleFactor: number;
  originX: number;
  originY: number;
  pngBase64?: string;
}

interface AreaSessionPayload {
  captureId: string;
  session: AreaCaptureSession;
  qualityScale: number;
  delayedCaptureSeconds: number;
  liveSelection: boolean;
}

interface CaptureCropRequestPayload {
  captureId: string;
  rect: CaptureRegionRect;
  qualityScale: number;
  delayedCaptureSeconds: number;
  liveSelection: boolean;
}

interface CaptureCancelPayload {
  restoreWindow?: boolean;
}

const APP_VERSION = '0.1.63';
const SETTINGS_KEY = 'dendro-capture:settings';
const DEVICE_KEY = 'dendro-capture:device';
const PENDING_KEY = 'dendro-capture:pending';
const LOCAL_CAPTURES_KEY = 'dendro-capture:local-captures';
const LIVE_SELECTION_DEFAULT_KEY = 'dendro-capture:live-selection-default-v1';
const OPEN_AFTER_UPLOAD_DEFAULT_OFF_KEY = 'dendro-capture:open-after-upload-default-off-v1';
const SIDEBAR_KEY = 'dendro-capture:sidebar-collapsed';
const CHUNK_SIZE = 8 * 1024 * 1024;
const MIN_APP_WIDTH = 820;
const MIN_APP_HEIGHT = 500;
const MAX_APP_WIDTH = 1120;
const MAX_APP_HEIGHT = 720;
const DEFAULT_AREA_SHORTCUT = 'Ctrl+Alt+C';
const OLD_DEFAULT_AREA_SHORTCUT = 'Alt+Shift+4';
const GOOGLE_DRIVE_API_CONSOLE_URL = 'https://console.cloud.google.com/apis/library/drive.googleapis.com';
const GOOGLE_AUTH_CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';
const GOOGLE_AUTH_AUDIENCE_URL = 'https://console.cloud.google.com/auth/audience';
const GOOGLE_CREDENTIALS_DOCS_URL = 'https://developers.google.com/workspace/guides/create-credentials';
const DENDRO_STUDIOS_CAPTURES_URL = 'https://dendrostudios.com/admin/?tab=toolkit&tool=captures';

const defaultSettings: CaptureSettings = {
  apiBaseUrl: 'http://localhost:3001/api',
  areaShortcut: DEFAULT_AREA_SHORTCUT,
  fullscreenShortcut: 'Alt+Shift+5',
  qualityScale: 1,
  delayedAreaCaptureSeconds: 2,
  deviceName: 'DendroCapture Desktop',
  captureDestination: 'local',
  apiSendingEnabled: true,
  openAfterUpload: false,
  hideDuringCapture: true,
  liveAreaSelection: true,
  saveLocally: true,
  googleDriveUploadEnabled: false,
  googleDriveOcrEnabled: true,
  googleDriveClientId: '',
  googleDriveClientSecret: '',
  launchOnStartup: true,
};

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || parsed === undefined) return fallback;

    if (Array.isArray(fallback)) {
      if (Array.isArray(parsed)) return parsed as T;
      if (typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>) as T;
      return fallback;
    }

    if (typeof fallback === 'object' && fallback !== null) {
      if (typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...fallback, ...(parsed as Record<string, unknown>) } as T;
      }
      return fallback;
    }

    return parsed as T;
  } catch {
    return fallback;
  }
};

const saveJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not persist ${key}`, error);
  }
};

const errorMessage = (error: unknown, fallback = 'Something went wrong'): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim();
    if (message) return message;
  }
  return fallback;
};

const hasPairedDevice = (device: Partial<DeviceState> | null | undefined): device is DeviceState =>
  Boolean(device?.deviceId?.trim() && device?.publicKey?.trim());

const loadDeviceState = (): DeviceState | null => {
  const raw = loadJson<Partial<DeviceState> | null>(DEVICE_KEY, null);
  if (hasPairedDevice(raw)) {
    return {
      deviceId: raw.deviceId.trim(),
      publicKey: raw.publicKey.trim(),
    };
  }
  if (raw) localStorage.removeItem(DEVICE_KEY);
  return null;
};

const loadSettings = (): CaptureSettings => {
  const raw = loadJson<Partial<CaptureSettings>>(SETTINGS_KEY, defaultSettings);
  // Persisted values can be stale or hand-edited; never let a bad type crash boot.
  const str = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value : fallback;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const qualityScale = typeof raw.qualityScale === 'number' && Number.isFinite(raw.qualityScale)
    ? clampNumber(raw.qualityScale, 0.25, 1)
    : defaultSettings.qualityScale;
  const delayedAreaCaptureSeconds = typeof raw.delayedAreaCaptureSeconds === 'number' && Number.isFinite(raw.delayedAreaCaptureSeconds)
    ? clampNumber(raw.delayedAreaCaptureSeconds, 0, 10)
    : defaultSettings.delayedAreaCaptureSeconds;
  const liveSelectionDefaultApplied = localStorage.getItem(LIVE_SELECTION_DEFAULT_KEY) === '1';
  const liveAreaSelection = typeof raw.liveAreaSelection === 'boolean'
    ? (liveSelectionDefaultApplied ? raw.liveAreaSelection : true)
    : defaultSettings.liveAreaSelection;
  const openAfterUploadDefaultOffApplied = localStorage.getItem(OPEN_AFTER_UPLOAD_DEFAULT_OFF_KEY) === '1';
  const openAfterUpload = openAfterUploadDefaultOffApplied
    ? bool(raw.openAfterUpload, defaultSettings.openAfterUpload)
    : false;
  const rawDestination = typeof raw.captureDestination === 'string' ? raw.captureDestination : '';
  const captureDestination: CaptureDestination = rawDestination === 'dendroApi' || rawDestination === 'googleDrive' || rawDestination === 'local'
    ? rawDestination
    : raw.googleDriveUploadEnabled === true
      ? 'googleDrive'
      : defaultSettings.captureDestination;
  if (!liveSelectionDefaultApplied) localStorage.setItem(LIVE_SELECTION_DEFAULT_KEY, '1');
  if (!openAfterUploadDefaultOffApplied) localStorage.setItem(OPEN_AFTER_UPLOAD_DEFAULT_OFF_KEY, '1');
  const settings: CaptureSettings = {
    apiBaseUrl: str(raw.apiBaseUrl, defaultSettings.apiBaseUrl),
    areaShortcut: str(raw.areaShortcut, defaultSettings.areaShortcut),
    fullscreenShortcut: str(raw.fullscreenShortcut, defaultSettings.fullscreenShortcut),
    qualityScale,
    delayedAreaCaptureSeconds,
    deviceName: str(raw.deviceName, defaultSettings.deviceName),
    captureDestination,
    apiSendingEnabled: bool(raw.apiSendingEnabled, defaultSettings.apiSendingEnabled),
    openAfterUpload,
    hideDuringCapture: bool(raw.hideDuringCapture, defaultSettings.hideDuringCapture),
    liveAreaSelection,
    saveLocally: bool(raw.saveLocally, defaultSettings.saveLocally),
    googleDriveUploadEnabled: bool(raw.googleDriveUploadEnabled, defaultSettings.googleDriveUploadEnabled),
    googleDriveOcrEnabled: bool(raw.googleDriveOcrEnabled, defaultSettings.googleDriveOcrEnabled),
    googleDriveClientId: str(raw.googleDriveClientId, defaultSettings.googleDriveClientId),
    googleDriveClientSecret: str(raw.googleDriveClientSecret, defaultSettings.googleDriveClientSecret),
    launchOnStartup: bool(raw.launchOnStartup, defaultSettings.launchOnStartup),
  };
  return {
    ...settings,
    areaShortcut: normalizedShortcut(settings.areaShortcut) === OLD_DEFAULT_AREA_SHORTCUT
      ? DEFAULT_AREA_SHORTCUT
      : settings.areaShortcut,
  };
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const dataUrl = (base64: string): string => `data:image/png;base64,${base64}`;

let ocrWorkerPromise: ReturnType<typeof Tesseract.createWorker> | null = null;

const getOcrWorker = () => {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract
      .createWorker('eng+fra', undefined, {
        workerPath: '/ocr/worker.min.js',
        corePath: '/ocr/core',
        langPath: '/ocr/tessdata/',
        workerBlobURL: false,
        gzip: true,
      })
      .catch((error) => {
        ocrWorkerPromise = null;
        throw error;
      }) as ReturnType<typeof Tesseract.createWorker>;
  }
  return ocrWorkerPromise;
};

const recognizeCaptureText = async (pngBase64: string): Promise<string> => {
  const worker = await getOcrWorker();
  const result = await worker.recognize(dataUrl(pngBase64));
  return result.data.text.replace(/\0/g, ' ').trim();
};

const capturePreviewBase64 = (base64: string, maxWidth = 420): Promise<string> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxWidth / Math.max(1, image.naturalWidth));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Could not create capture preview'));
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));
    };
    image.onerror = () => reject(new Error('Could not create capture preview'));
    image.src = dataUrl(base64);
  });

const loadPendingQueue = (): PendingCapture[] =>
  loadJson<Array<Partial<PendingCapture> & { pngBase64?: string }>>(PENDING_KEY, [])
    .filter((item) => typeof item.id === 'string' && typeof item.mode === 'string' && !item.pngBase64)
    .map((item) => {
      const mode: CaptureMode = item.mode === 'fullscreen' ? 'fullscreen' : 'area';
      const destination: UploadDestination = item.destination === 'googleDrive' ? 'googleDrive' : 'dendroApi';
      return {
        id: String(item.id),
        mode,
        capturedAt: typeof item.capturedAt === 'string' ? item.capturedAt : new Date().toISOString(),
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        displayWidth: Number(item.displayWidth) || Number(item.width) || 0,
        displayHeight: Number(item.displayHeight) || Number(item.height) || 0,
        scaleFactor: Number(item.scaleFactor) || 1,
        appName: typeof item.appName === 'string' ? item.appName : undefined,
        windowTitle: typeof item.windowTitle === 'string' ? item.windowTitle : undefined,
        previewBase64: typeof item.previewBase64 === 'string' && item.previewBase64.length < 300_000
          ? item.previewBase64
          : undefined,
        destination,
        assetUrl: typeof item.assetUrl === 'string' ? item.assetUrl : undefined,
        googleDriveFileId: typeof item.googleDriveFileId === 'string' ? item.googleDriveFileId : undefined,
        googleDriveUrl: typeof item.googleDriveUrl === 'string' ? item.googleDriveUrl : undefined,
        googleDriveFolderUrl: typeof item.googleDriveFolderUrl === 'string' ? item.googleDriveFolderUrl : undefined,
      };
    })
    .slice(0, 20);

const apiUrl = (settings: CaptureSettings, path: string): string => {
  const base = settings.apiBaseUrl.trim().replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
};

const apiBaseLabel = (settings: CaptureSettings): string =>
  settings.apiBaseUrl.trim().replace(/\/+$/, '') || 'empty API URL';

const normalizedShortcut = (value: string): string =>
  value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('+');

const shortcutTitle = (field: ShortcutField): string =>
  field === 'areaShortcut' ? 'Capture Area' : 'Capture Fullscreen';

const shortcutBaseKey = (event: KeyboardEvent): string | null => {
  if (['Alt', 'Control', 'Shift', 'Meta'].includes(event.key)) return null;
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^Numpad[0-9]$/.test(event.code)) return event.code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key.toUpperCase();

  switch (event.key) {
    case ' ':
    case 'Spacebar':
      return 'Space';
    case 'ArrowUp':
    case 'ArrowRight':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'Backspace':
    case 'Delete':
    case 'Enter':
    case 'Tab':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
      return event.key;
    default:
      return event.key.length === 1 ? event.key.toUpperCase() : event.key;
  }
};

const shortcutFromKeyboardEvent = (event: KeyboardEvent): string | null => {
  const key = shortcutBaseKey(event);
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length === 0 && !isFunctionKey) return null;

  return [...parts, key].join('+');
};

type CaptureFileSource = {
  mode?: CaptureMode;
  appName?: string | null;
  windowTitle?: string | null;
  width?: number | null;
  height?: number | null;
};

const slugForFileName = (value?: string | null, fallback = 'capture'): string => {
  const slug = (value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '');
  return slug || fallback;
};

const captureFileName = (date: Date, source?: CaptureFileSource): string => {
  const validDate = Number.isFinite(date.getTime()) ? date : new Date();
  const timestamp = [
    validDate.getHours(),
    validDate.getMinutes(),
    validDate.getSeconds(),
  ].map((value) => String(value).padStart(2, '0')).join('');
  const dimensions = source?.width && source?.height ? `${source.width}x${source.height}` : '';
  const fallback = dimensions || (source?.mode === 'fullscreen' ? 'fullscreen' : source?.mode === 'area' ? 'area' : 'capture');
  const sourceName = slugForFileName(source?.appName, fallback);
  return `dendrocapture-${sourceName}-${timestamp}.png`;
};

const captureDayFolderName = (date: Date): string => {
  const validDate = Number.isFinite(date.getTime()) ? date : new Date();
  const year = validDate.getFullYear();
  const month = String(validDate.getMonth() + 1).padStart(2, '0');
  const day = String(validDate.getDate()).padStart(2, '0');
  return `dendrocapture-${year}-${month}-${day}`;
};

const captureId = (date = new Date()): string =>
  `${date.getTime()}-${Math.random().toString(36).slice(2)}`;

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

const withTimeout = async <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const relativeTime = (iso?: string): string => {
  if (!iso) return 'Never';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return 'Unknown';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 8 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

const captureTitle = (capture: Pick<PendingCapture, 'mode' | 'capturedAt' | 'appName' | 'windowTitle'>): string => {
  const source = capture.appName || capture.windowTitle || (capture.mode === 'fullscreen' ? 'Fullscreen' : 'Area');
  const stamp = new Date(capture.capturedAt).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${source} - ${stamp}`;
};

const captureDestinationLabel = (destination: CaptureDestination): string => {
  switch (destination) {
    case 'dendroApi':
      return 'Dendro API';
    case 'googleDrive':
      return 'Google Drive';
    default:
      return 'Local';
  }
};

const onlineImageUrl = (capture?: Pick<PendingCapture, 'assetUrl' | 'googleDriveUrl' | 'googleDriveFolderUrl'> | null): string | undefined =>
  capture?.assetUrl || capture?.googleDriveUrl || capture?.googleDriveFolderUrl || undefined;

const googleDriveFolderUrl = (folderId?: string | null): string | undefined =>
  folderId ? `https://drive.google.com/drive/u/0/folders/${encodeURIComponent(folderId)}` : undefined;

const dendroCapturesUrl = (apiBaseUrl: string): string | undefined => {
  try {
    const url = new URL(apiBaseUrl.trim());
    if (url.hostname === 'dendrostudios.com' || url.hostname.endsWith('.dendrostudios.com')) {
      return DENDRO_STUDIOS_CAPTURES_URL;
    }
    url.search = '';
    url.hash = '';
    if (url.hostname.startsWith('api.')) {
      url.hostname = url.hostname.slice(4);
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const apiIndex = segments.lastIndexOf('api');
    const baseSegments = apiIndex >= 0 ? segments.slice(0, apiIndex) : [];
    url.pathname = `/${[...baseSegments, 'captures'].join('/')}`;
    return url.toString();
  } catch {
    return undefined;
  }
};

const tabTitle = (tab: AppTab): string => {
  switch (tab) {
    case 'history':
      return 'History';
    case 'queue':
      return 'Queue';
    case 'settings':
      return 'Settings';
    default:
      return 'Capture';
  }
};

const clampPoint = (event: React.PointerEvent<HTMLElement>) => ({
  x: Math.max(0, Math.min(event.clientX, window.innerWidth)),
  y: Math.max(0, Math.min(event.clientY, window.innerHeight)),
});

const platformLabel = async (): Promise<string> => {
  try {
    return await invoke<string>('platform_label');
  } catch {
    return navigator.platform || 'unknown';
  }
};

const cleanCaptureContext = (value: CaptureWindowContext | null | undefined): CaptureWindowContext | null => {
  const appName = String(value?.appName || '').replace(/\0/g, '').trim().slice(0, 120);
  const windowTitle = String(value?.windowTitle || '').replace(/\0/g, '').trim().slice(0, 260);
  return appName || windowTitle ? { appName: appName || undefined, windowTitle: windowTitle || undefined } : null;
};

const isDendroCaptureContext = (value: CaptureWindowContext | null | undefined): boolean => {
  const combined = `${value?.appName || ''} ${value?.windowTitle || ''}`.toLowerCase();
  return combined.includes('dendrocapture') || combined.includes('dendro_capture');
};

const CaptureOverlayApp = () => {
  const [payload, setPayload] = useState<AreaSessionPayload | null>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [delayedCaptureArmed, setDelayedCaptureArmed] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const resetSelection = useCallback(() => {
    setStart(null);
    setCurrent(null);
    setPointer(null);
    setDelayedCaptureArmed(false);
    setFinishing(false);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('dc-capture-overlay-page');
    document.body.classList.add('dc-capture-overlay-body');
    return () => {
      document.documentElement.classList.remove('dc-capture-overlay-page');
      document.body.classList.remove('dc-capture-overlay-body');
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const unlisteners: Array<() => void> = [];

    const boot = async () => {
      unlisteners.push(await listen<AreaSessionPayload>('capture-snapshot', (event) => {
        resetSelection();
        setPayload(event.payload);
        void emitTo('main', 'capture-overlay-session-ready', event.payload.captureId).catch(() => undefined);
      }));
      // The overlay window is kept alive between captures; main tells it to
      // drop the frozen frame so the multi-megabyte preview can be collected.
      unlisteners.push(await listen('capture-overlay-reset', () => {
        resetSelection();
        setPayload(null);
      }));
      if (mounted) await emitTo('main', 'capture-overlay-ready', 'area');
    };

    void boot();
    return () => {
      mounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [resetSelection]);

  const cancelOverlay = useCallback(async (restoreWindow = true) => {
    resetSelection();
    await emitTo('main', 'capture-cancelled', { restoreWindow } satisfies CaptureCancelPayload).catch(() => undefined);
  }, [resetSelection]);

  useEffect(() => {
    // The global shortcut is still the reliable cancel path if a game or
    // compositor does not send key events to the webview.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void cancelOverlay(false);
    };
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('keyup', onEscape, true);
    return () => {
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('keyup', onEscape, true);
    };
  }, [cancelOverlay]);

  const selectionBox = useMemo(() => {
    if (!start || !current) return null;
    return {
      left: Math.min(start.x, current.x),
      top: Math.min(start.y, current.y),
      width: Math.abs(start.x - current.x),
      height: Math.abs(start.y - current.y),
    };
  }, [current, start]);

  const finishSelection = async () => {
    if (finishing || !payload) return;
    if (!selectionBox || selectionBox.width < 8 || selectionBox.height < 8) {
      await cancelOverlay();
      return;
    }

    setFinishing(true);
    const delayedCaptureSeconds = delayedCaptureArmed
      ? clampNumber(payload.delayedCaptureSeconds, 0, 10)
      : 0;
    const scaleX = payload.session.width / Math.max(1, window.innerWidth);
    const scaleY = payload.session.height / Math.max(1, window.innerHeight);
    const rect: CaptureRegionRect = {
      x: payload.session.originX + Math.max(0, Math.round(selectionBox.left * scaleX)),
      y: payload.session.originY + Math.max(0, Math.round(selectionBox.top * scaleY)),
      width: Math.max(1, Math.round(selectionBox.width * scaleX)),
      height: Math.max(1, Math.round(selectionBox.height * scaleY)),
    };

    // Wait for the now-empty overlay frame to be composited so the selection
    // chrome can never appear in the captured pixels, even if hiding the
    // window races the screen grab.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });

    try {
      await emitTo('main', 'capture-crop-request', {
        captureId: payload.captureId,
        rect,
        qualityScale: payload.qualityScale,
        delayedCaptureSeconds,
        liveSelection: payload.liveSelection,
      } satisfies CaptureCropRequestPayload);
    } catch (error) {
      await emitTo('main', 'capture-error', error instanceof Error ? error.message : 'Area capture failed')
        .catch(() => undefined);
    }
  };

  // While finishing, render nothing at all: a fully transparent window means
  // the screen grab sees only the real desktop underneath.
  if (finishing) {
    return <div className="dc-capture-overlay-root finishing" onContextMenu={(event) => event.preventDefault()} />;
  }

  const cancelDodged = !!pointer && pointer.x > window.innerWidth - 240 && pointer.y < 150;

  return (
    <div
      className="dc-capture-overlay-root"
      onPointerDown={(event) => {
        if (finishing || !payload) return;
        if (event.button === 2) {
          event.preventDefault();
          if (start && current && payload.delayedCaptureSeconds > 0) {
            setDelayedCaptureArmed(true);
          }
          return;
        }
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = clampPoint(event);
        setStart(point);
        setCurrent(point);
        setPointer(point);
      }}
      onPointerMove={(event) => {
        if (finishing || !payload) return;
        const point = clampPoint(event);
        setPointer(point);
        if (start) setCurrent(point);
        if (start && payload.delayedCaptureSeconds > 0 && (event.buttons & 2) === 2) {
          setDelayedCaptureArmed(true);
        }
      }}
      onPointerUp={(event) => {
        if (event.button === 0) void finishSelection();
      }}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
    >
      {payload && !payload.liveSelection && payload.session.pngBase64 ? (
        <img
          className="dc-overlay-snapshot"
          src={dataUrl(payload.session.pngBase64)}
          alt=""
          draggable={false}
        />
      ) : null}
      <button
        type="button"
        className={`dc-overlay-cancel${cancelDodged ? ' dodge' : ''}`}
        title="press ESC"
        aria-label="Cancel capture selection. Press ESC."
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => void cancelOverlay(true)}
      >
        <X size={16} />
        Cancel
      </button>
      {pointer && !selectionBox && (
        <>
          <div className="dc-overlay-crosshair x" style={{ top: pointer.y }} />
          <div className="dc-overlay-crosshair y" style={{ left: pointer.x }} />
        </>
      )}
      {selectionBox && (
        <div
          className="dc-selection"
          style={{
            left: selectionBox.left,
            top: selectionBox.top,
            width: selectionBox.width,
            height: selectionBox.height,
          }}
        >
          <span>
            {Math.round(selectionBox.width)} x {Math.round(selectionBox.height)}
            {delayedCaptureArmed ? ` - ${clampNumber(payload?.delayedCaptureSeconds || 0, 0, 10)}s delay` : ''}
          </span>
        </div>
      )}
    </div>
  );
};

class BootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="dc-boot-error">
        <div>
          <h1>DendroCapture could not start</h1>
          <p>{this.state.error.message || 'The interface crashed while loading.'}</p>
          <small>Close the app and reopen it. If this keeps happening, send this message back to Codex.</small>
        </div>
      </div>
    );
  }
}

const DendroCaptureApp = () => {
  const [settings, setSettings] = useState<CaptureSettings>(loadSettings);
  const [device, setDevice] = useState<DeviceState | null>(loadDeviceState);
  const [googleDrive, setGoogleDrive] = useState<GoogleDriveStatus>({
    configured: false,
    linked: false,
  });
  const [pending, setPending] = useState<PendingCapture[]>(loadPendingQueue);
  // History is restored from the local-captures folder on boot (see the
  // list_local_captures effect below) and updated in memory afterwards.
  const [localCaptures, setLocalCaptures] = useState<LocalCapture[]>([]);
  const [tab, setTab] = useState<AppTab>('capture');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('destination');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => loadJson(SIDEBAR_KEY, false));
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('Ready');
  const [lastCapture, setLastCapture] = useState<PendingCapture | null>(null);
  const [lastCaptureImage, setLastCaptureImage] = useState<string | null>(null);
  const [editingCapture, setEditingCapture] = useState<EditingCapture | null>(null);
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutField | null>(null);
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false);
  const [fullscreenPicker, setFullscreenPicker] = useState<{
    loading: boolean;
    previews: MonitorPreview[];
    error?: string;
  } | null>(null);
  const settingsRef = useRef(settings);
  const deviceRef = useRef(device);
  const googleDriveRef = useRef(googleDrive);
  const busyRef = useRef<string | null>(busy);
  const fitWindowTimerRef = useRef<number | null>(null);
  const areaSessionRef = useRef<{ captureId: string; session: AreaCaptureSession } | null>(null);
  const pendingAreaPayloadRef = useRef<AreaSessionPayload | null>(null);
  const areaDeliveryWatchdogRef = useRef<number | null>(null);
  const overlayReadyRef = useRef(false);
  const escapeRegisteredRef = useRef(false);
  const mainWasVisibleRef = useRef(false);
  const shortcutOpsRef = useRef<Promise<void>>(Promise.resolve());
  const editingCaptureRef = useRef(false);
  const googleDriveLinkAttemptRef = useRef(0);
  const activeCaptureContextRef = useRef<CaptureWindowContext | null>(null);
  const lastExternalContextRef = useRef<CaptureWindowContext | null>(null);
  const processCaptureRef = useRef<(
    mode: CaptureMode,
    capture: NativeCapture,
    context?: CaptureWindowContext | null
  ) => Promise<void>>(async () => undefined);

  useEffect(() => {
    const prepareTrayStartup = async () => {
      const win = getCurrentWindow();
      await win.setFullscreen(false).catch(() => undefined);
      await win.setAlwaysOnTop(false).catch(() => undefined);
      await win.setSkipTaskbar(true).catch(() => undefined);
      await win.setDecorations(false).catch(() => undefined);
      await win.setResizable(false).catch(() => undefined);
      await win.unmaximize().catch(() => undefined);
      await win.hide().catch(() => undefined);
    };
    void prepareTrayStartup();
  }, []);

  const fitWindowToCurrentMonitor = useCallback(async () => {
    const win = getCurrentWindow();
    const monitor = await currentMonitor().catch(() => null);
    const scaleFactor = monitor?.scaleFactor || 1;
    const workWidth = monitor ? monitor.workArea.size.width / scaleFactor : 1440;
    const workHeight = monitor ? monitor.workArea.size.height / scaleFactor : 900;
    const width = Math.round(clampNumber(Math.min(workWidth - 32, workWidth * 0.62), MIN_APP_WIDTH, MAX_APP_WIDTH));
    const height = Math.round(clampNumber(Math.min(workHeight - 32, workHeight * 0.68), MIN_APP_HEIGHT, MAX_APP_HEIGHT));
    await win.setResizable(false).catch(() => undefined);
    await win.setSize(new LogicalSize(width, height)).catch(() => undefined);
  }, []);

  const enlargeWindowForEditor = useCallback(async () => {
    const win = getCurrentWindow();
    const monitor = await currentMonitor().catch(() => null);
    const scaleFactor = monitor?.scaleFactor || 1;
    const workWidth = monitor ? monitor.workArea.size.width / scaleFactor : 1440;
    const workHeight = monitor ? monitor.workArea.size.height / scaleFactor : 900;
    const width = Math.round(Math.max(MIN_APP_WIDTH, Math.min(workWidth - 48, 1480)));
    const height = Math.round(Math.max(MIN_APP_HEIGHT, Math.min(workHeight - 48, 940)));
    await win.setSize(new LogicalSize(width, height)).catch(() => undefined);
    await win.center().catch(() => undefined);
  }, []);

  useEffect(() => {
    const isEditing = !!editingCapture;
    editingCaptureRef.current = isEditing;
    // Annotating a capture inside the compact app window is cramped; grow to
    // most of the work area while the editor is open and shrink back after.
    if (isEditing) void enlargeWindowForEditor();
    else void fitWindowToCurrentMonitor();
  }, [!!editingCapture, enlargeWindowForEditor, fitWindowToCurrentMonitor]);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlistenMoved: (() => void) | null = null;
    let unlistenScale: (() => void) | null = null;

    const scheduleFit = () => {
      if (fitWindowTimerRef.current !== null) window.clearTimeout(fitWindowTimerRef.current);
      fitWindowTimerRef.current = window.setTimeout(() => {
        fitWindowTimerRef.current = null;
        if (editingCaptureRef.current) return;
        void fitWindowToCurrentMonitor();
      }, 520);
    };

    void fitWindowToCurrentMonitor();
    void win.onMoved(() => scheduleFit()).then((unlisten) => {
      unlistenMoved = unlisten;
    }).catch(() => undefined);
    void win.onScaleChanged(() => scheduleFit()).then((unlisten) => {
      unlistenScale = unlisten;
    }).catch(() => undefined);

    return () => {
      if (fitWindowTimerRef.current !== null) window.clearTimeout(fitWindowTimerRef.current);
      unlistenMoved?.();
      unlistenScale?.();
    };
  }, [fitWindowToCurrentMonitor]);

  useEffect(() => {
    let unlistenClose: (() => void) | null = null;

    const bindCloseToTray = async () => {
      const win = getCurrentWindow();
      unlistenClose = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        setStatus('DendroCapture is running in the tray');
        await win.setSkipTaskbar(true).catch(() => undefined);
        await win.hide().catch(() => undefined);
      });
    };

    void bindCloseToTray();
    return () => {
      unlistenClose?.();
    };
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    // Failures must surface somewhere visible; a swallowed rejection is how
    // an app ends up looking alive while nothing reacts.
    const onRejection = (event: PromiseRejectionEvent) => {
      console.warn('Unhandled rejection', event.reason);
      const message = errorMessage(event.reason, '');
      setStatus(message ? `Something went wrong: ${message}` : 'Something went wrong');
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    saveJson(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    googleDriveRef.current = googleDrive;
  }, [googleDrive]);

  useEffect(() => {
    deviceRef.current = device;
    if (hasPairedDevice(device)) saveJson(DEVICE_KEY, device);
    else localStorage.removeItem(DEVICE_KEY);
  }, [device]);

  useEffect(() => {
    saveJson(PENDING_KEY, pending.slice(0, 20));
  }, [pending]);

  useEffect(() => {
    // History used to be persisted in localStorage; clean up data left behind
    // by older versions.
    localStorage.removeItem(LOCAL_CAPTURES_KEY);
  }, []);

  useEffect(() => {
    let alive = true;
    const restoreHistory = async () => {
      try {
        const records = await invoke<Array<{ metadataJson: string; filePath: string }>>(
          'list_local_captures',
          { limit: 60 },
        );
        if (!alive || records.length === 0) return;
        const restored: LocalCapture[] = [];
        for (const record of records) {
          try {
            const meta = JSON.parse(record.metadataJson) as Partial<LocalCapture>;
            if (typeof meta.id !== 'string' || typeof meta.capturedAt !== 'string') continue;
            restored.push({
              id: meta.id,
              mode: meta.mode === 'fullscreen' ? 'fullscreen' : 'area',
              capturedAt: meta.capturedAt,
              width: Number(meta.width) || 0,
              height: Number(meta.height) || 0,
              displayWidth: Number(meta.displayWidth) || Number(meta.width) || 0,
              displayHeight: Number(meta.displayHeight) || Number(meta.height) || 0,
              scaleFactor: Number(meta.scaleFactor) || 1,
              appName: typeof meta.appName === 'string' ? meta.appName : undefined,
              windowTitle: typeof meta.windowTitle === 'string' ? meta.windowTitle : undefined,
              previewBase64: typeof meta.previewBase64 === 'string' ? meta.previewBase64 : undefined,
              assetUrl: typeof meta.assetUrl === 'string' ? meta.assetUrl : undefined,
              googleDriveFileId: typeof meta.googleDriveFileId === 'string' ? meta.googleDriveFileId : undefined,
              googleDriveUrl: typeof meta.googleDriveUrl === 'string' ? meta.googleDriveUrl : undefined,
              googleDriveFolderUrl: typeof meta.googleDriveFolderUrl === 'string' ? meta.googleDriveFolderUrl : undefined,
              filePath: record.filePath,
            });
          } catch {
            // Skip captures with unreadable metadata.
          }
        }
        setLocalCaptures((current) => {
          const known = new Set(current.map((item) => item.id));
          return [...current, ...restored.filter((item) => !known.has(item.id))].slice(0, 80);
        });
      } catch (error) {
        console.warn('Could not restore capture history', error);
      }
    };
    void restoreHistory();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    saveJson(SIDEBAR_KEY, sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    invoke(settings.launchOnStartup ? 'plugin:autostart|enable' : 'plugin:autostart|disable')
      .catch((error) => console.warn('Could not update launch on startup', error));
  }, [settings.launchOnStartup]);

  const refreshGoogleDriveStatus = useCallback(async () => {
    try {
      const status = await invoke<GoogleDriveStatus>('google_drive_status', {
        clientId: settingsRef.current.googleDriveClientId.trim() || null,
        clientSecret: settingsRef.current.googleDriveClientSecret.trim() || null,
      });
      setGoogleDrive(status);
      if (status.clientId && !settingsRef.current.googleDriveClientId.trim()) {
        setSettings((current) => current.googleDriveClientId.trim()
          ? current
          : { ...current, googleDriveClientId: status.clientId || '' });
      }
      return status;
    } catch (error) {
      console.warn('Could not read Google Drive status', error);
      const fallback = { configured: false, linked: false } satisfies GoogleDriveStatus;
      setGoogleDrive(fallback);
      return fallback;
    }
  }, []);

  useEffect(() => {
    void refreshGoogleDriveStatus();
  }, [refreshGoogleDriveStatus, settings.googleDriveClientId, settings.googleDriveClientSecret]);

  const updateSettings = (patch: Partial<CaptureSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const selectCaptureDestination = (destination: CaptureDestination) => {
    setSettingsSection(destination);
    setSettings((current) => ({
      ...current,
      captureDestination: destination,
      saveLocally: destination === 'local' ? true : current.saveLocally,
      apiSendingEnabled: destination === 'dendroApi' ? true : current.apiSendingEnabled,
      googleDriveUploadEnabled: destination === 'googleDrive',
    }));
    if (destination === 'googleDrive' && (!settingsRef.current.googleDriveClientId.trim() || !settingsRef.current.googleDriveClientSecret.trim())) {
      setStatus('Google Drive selected. Paste the OAuth desktop Client ID and Client Secret to link it.');
    } else if (destination === 'googleDrive' && !googleDriveRef.current.linked) {
      setStatus('Google Drive selected. Link your account before captures upload there.');
    } else {
      setStatus(`Capture destination set to ${destination === 'local' ? 'Local' : destination === 'dendroApi' ? 'Dendro API' : 'Google Drive'}`);
    }
  };

  const linkGoogleDrive = async () => {
    if (busyRef.current && busyRef.current !== 'google-drive-link') return;
    const clientId = settingsRef.current.googleDriveClientId.trim();
    const clientSecret = settingsRef.current.googleDriveClientSecret.trim();
    if (!clientId) {
      setStatus('Paste a Google OAuth desktop client ID first');
      return;
    }
    if (!clientSecret) {
      setStatus('Paste the Google OAuth desktop client secret too');
      return;
    }
    if (!clientId.endsWith('.apps.googleusercontent.com')) {
      setStatus('Paste the OAuth Client ID, not the Client Secret. The Client ID usually ends with .apps.googleusercontent.com');
      return;
    }
    if (clientSecret.endsWith('.apps.googleusercontent.com')) {
      setStatus('Paste the OAuth Client Secret in the secret field, not another Client ID');
      return;
    }
    const attemptId = googleDriveLinkAttemptRef.current + 1;
    googleDriveLinkAttemptRef.current = attemptId;
    busyRef.current = 'google-drive-link';
    setBusy('google-drive-link');
    setStatus('Opening Google Drive link flow. If Google shows an error, correct the client ID or secret and click Link again.');
    try {
      const linked = await withTimeout(
        invoke<GoogleDriveLinkResult>('google_drive_link', { clientId, clientSecret }),
        90_000,
        'Google did not return to DendroCapture. Check the client ID and secret, then click Link Google Drive again.',
      );
      if (googleDriveLinkAttemptRef.current !== attemptId) return;
      setGoogleDrive({
        configured: true,
        linked: true,
        clientId,
        email: linked.email,
        folderId: linked.folderId,
        folderName: linked.folderName,
      });
      updateSettings({ captureDestination: 'googleDrive', googleDriveUploadEnabled: true });
      setStatus('Google Drive linked');
    } catch (error) {
      if (googleDriveLinkAttemptRef.current !== attemptId) return;
      setStatus(errorMessage(error, 'Could not link Google Drive'));
      await refreshGoogleDriveStatus();
    } finally {
      if (googleDriveLinkAttemptRef.current === attemptId) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  };

  const unlinkGoogleDrive = async () => {
    if (busyRef.current) return;
    busyRef.current = 'google-drive-unlink';
    setBusy('google-drive-unlink');
    setStatus('Unlinking Google Drive');
    try {
      await invoke('google_drive_unlink');
      updateSettings({ googleDriveUploadEnabled: false, captureDestination: 'local' });
      await refreshGoogleDriveStatus();
      setStatus('Google Drive unlinked');
    } catch (error) {
      setStatus(errorMessage(error, 'Could not unlink Google Drive'));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const readActiveWindowContext = useCallback(async (): Promise<CaptureWindowContext | null> => {
    try {
      const context = cleanCaptureContext(await invoke<CaptureWindowContext>('active_window_context'));
      if (context && !isDendroCaptureContext(context)) {
        lastExternalContextRef.current = context;
        return context;
      }
    } catch {
      return lastExternalContextRef.current;
    }
    return lastExternalContextRef.current;
  }, []);

  const setShortcut = useCallback((field: ShortcutField, value: string): boolean => {
    const shortcut = normalizedShortcut(value);
    if (!shortcut) return false;

    const otherField: ShortcutField = field === 'areaShortcut' ? 'fullscreenShortcut' : 'areaShortcut';
    if (normalizedShortcut(settingsRef.current[otherField]).toLowerCase() === shortcut.toLowerCase()) {
      setStatus(`${shortcut} is already used by ${shortcutTitle(otherField)}`);
      return false;
    }

    setSettings((current) => ({ ...current, [field]: shortcut }));
    setStatus(`${shortcutTitle(field)} shortcut set to ${shortcut}`);
    return true;
  }, []);

  useEffect(() => {
    if (!recordingShortcut) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecordingShortcut(null);
        setStatus('Shortcut change canceled');
        return;
      }

      const nextShortcut = shortcutFromKeyboardEvent(event);
      if (!nextShortcut) {
        setStatus('Press a shortcut with a modifier, or use a function key');
        return;
      }

      if (setShortcut(recordingShortcut, nextShortcut)) {
        setRecordingShortcut(null);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recordingShortcut, setShortcut]);

  const apiPost = async <T,>(path: string, body: unknown, token?: string): Promise<T> => {
    const url = apiUrl(settingsRef.current, path);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const reason = errorMessage(error, '');
      throw new Error(`Could not reach Dendro API at ${apiBaseLabel(settingsRef.current)}${reason ? ` (${reason})` : ''}. Check the API URL, server deployment, and capture CORS origins.`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
    return data as T;
  };

  const ensureDeviceKey = async (): Promise<{ publicKey: string }> => {
    return invoke<{ publicKey: string }>('ensure_device_keypair');
  };

  const pairDevice = async () => {
    setBusy('pair');
    setStatus('Pairing device');
    try {
      const key = await ensureDeviceKey();
      const platform = await platformLabel();
      const result = await apiPost<{ ok: true; deviceId: string; scopes: string[] }>('/capture/devices/claim', {
        code: pairingCode,
        publicKey: key.publicKey,
        name: settings.deviceName,
        platform,
        appVersion: APP_VERSION,
      });
      const next = { deviceId: result.deviceId, publicKey: key.publicKey };
      setDevice(next);
      setPairingCode('');
      setStatus('Device paired');
    } catch (error) {
      setStatus(errorMessage(error, 'Pairing failed'));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const captureToken = async (): Promise<string> => {
    const currentDevice = deviceRef.current;
    if (!hasPairedDevice(currentDevice)) {
      setDevice(null);
      throw new Error('Pair DendroCapture again before uploading. The saved pairing is missing its device id.');
    }
    const challenge = await apiPost<{ challengeId: string; challenge: string }>('/capture/auth/challenge', {
      deviceId: currentDevice.deviceId,
    });
    const signature = await invoke<string>('sign_challenge', {
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
    });
    const token = await apiPost<{ accessToken: string }>('/capture/auth/token', {
      deviceId: currentDevice.deviceId,
      challengeId: challenge.challengeId,
      signature,
    });
    return token.accessToken;
  };

  const queueDestination = (capture: Pick<PendingCapture, 'destination'>): UploadDestination =>
    capture.destination === 'googleDrive' ? 'googleDrive' : 'dendroApi';

  const queueDestinationLabel = (capture: Pick<PendingCapture, 'destination'>): string =>
    queueDestination(capture) === 'googleDrive' ? 'Google Drive' : 'Dendro API';

  const addPending = (capture: PendingCapture) => {
    const destination = queueDestination(capture);
    const queued = { ...capture, destination };
    setPending((current) => [
      queued,
      ...current.filter((item) => item.id !== queued.id || queueDestination(item) !== destination),
    ].slice(0, 20));
  };

  const removePending = (id: string, destination?: UploadDestination) => {
    setPending((current) => {
      const next = current.filter((item) => {
        if (item.id !== id) return true;
        return destination ? queueDestination(item) !== destination : false;
      });
      if (!next.some((item) => item.id === id)) {
        void invoke('delete_pending_capture', { id }).catch(() => undefined);
      }
      return next;
    });
  };

  const revealCapture = async (item: LocalCapture) => {
    try {
      if (item.filePath) await invoke('reveal_in_folder', { path: item.filePath });
      else await invoke('reveal_pending_capture', { id: item.id });
    } catch (error) {
      setStatus(error instanceof Error ? `Could not show in folder: ${error.message}` : 'Could not show in folder');
    }
  };

  const addLocalCapture = (capture: LocalCapture) => {
    setLocalCaptures((current) => [capture, ...current.filter((item) => item.id !== capture.id)].slice(0, 80));
  };

  const updateCaptureRecord = (capture: LocalCapture) => {
    setLastCapture((current) => (current?.id === capture.id ? { ...current, ...capture } : current));
    setPending((current) => current.map((item) => (item.id === capture.id ? { ...item, ...capture } : item)));
    setLocalCaptures((current) => current.map((item) => (item.id === capture.id ? { ...item, ...capture } : item)));
  };

  const metadataForCapture = (capture: LocalCapture, sourceName: string, operationCount?: number) =>
    JSON.stringify({
      ...capture,
      sourceName,
      appVersion: APP_VERSION,
      annotationEditedAt: operationCount ? new Date().toISOString() : undefined,
      annotationOperationCount: operationCount,
    });

  const openDrawEditor = async (capture: LocalCapture, source: EditingCaptureSource) => {
    setStatus('Loading capture editor');
    try {
      let imageBase64: string | undefined;
      if (source === 'latest' && lastCapture?.id === capture.id && lastCaptureImage) {
        imageBase64 = lastCaptureImage;
      } else if (capture.filePath) {
        imageBase64 = await invoke<string>('read_local_capture', { path: capture.filePath });
      } else {
        imageBase64 = await invoke<string>('read_pending_capture', { id: capture.id }).catch(() => undefined);
      }
      // Never fall back to the 420px preview: editing it and saving with
      // "replace" would silently overwrite the full-resolution capture.
      if (!imageBase64) throw new Error('Could not load the original PNG for editing');
      setEditingCapture({
        source,
        item: capture,
        imageBase64,
        title: captureTitle(capture),
      });
      setStatus('Editing capture');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not open capture editor');
    }
  };

  const originalPngForCapture = async (capture: LocalCapture): Promise<string> => {
    if (lastCapture?.id === capture.id && lastCaptureImage) return lastCaptureImage;
    if (capture.filePath) return invoke<string>('read_local_capture', { path: capture.filePath });
    return invoke<string>('read_pending_capture', { id: capture.id });
  };

  const saveEditedCapture = async ({ pngBase64, replace, operationCount }: AnnotationSavePayload) => {
    if (!editingCapture) return;
    const base = editingCapture.item;
    const now = new Date();
    const targetDate = replace ? new Date(base.capturedAt) : now;
    const previewBase64 = await capturePreviewBase64(pngBase64).catch(() => undefined);
    const target: LocalCapture = {
      ...base,
      id: replace ? base.id : captureId(now),
      capturedAt: replace ? base.capturedAt : now.toISOString(),
      previewBase64,
      filePath: replace ? base.filePath : undefined,
    };
    const sourceName = replace && base.filePath
      ? base.filePath.split(/[\\/]/).pop() || captureFileName(targetDate, target)
      : captureFileName(targetDate, target);

    await invoke('copy_png_to_clipboard', { pngBase64 }).catch((error) => {
      console.warn('Could not copy edited capture to clipboard', error);
    });
    setLastCapture(target);
    setLastCaptureImage(pngBase64);

    const destination = settingsRef.current.captureDestination;
    if (destination === 'dendroApi' && hasPairedDevice(deviceRef.current) && settingsRef.current.apiSendingEnabled) {
      const uploadItem: PendingCapture = { ...target, destination: 'dendroApi' };
      let queuedForRetry = false;
      if (settingsRef.current.saveLocally) {
        await invoke('save_pending_capture', { id: uploadItem.id, pngBase64 }).catch((error) => {
          console.warn('Could not persist edited pending capture', error);
        });
        addPending(uploadItem);
        queuedForRetry = true;
      }
      setEditingCapture(null);
      setStatus('Uploading edited capture');
      try {
        const uploaded = await uploadCapture({ ...uploadItem, pngBase64 });
        if (uploaded.openUrl) {
          const uploadedItem = { ...uploadItem, assetUrl: uploaded.openUrl };
          setLastCapture(uploadedItem);
          updateCaptureRecord(uploadedItem);
        }
        setStatus('Edited capture uploaded');
      } catch (error) {
        setStatus(queuedForRetry
          ? `Edited capture queued: ${errorMessage(error, 'Upload failed')}`
          : `Edited capture upload failed: ${errorMessage(error, 'Upload failed')}`);
      }
      return;
    }

    if (destination === 'googleDrive' && googleDriveCanUpload()) {
      const uploadItem: PendingCapture = { ...target, destination: 'googleDrive' };
      let queuedForRetry = false;
      if (settingsRef.current.saveLocally) {
        await invoke('save_pending_capture', { id: uploadItem.id, pngBase64 }).catch((error) => {
          console.warn('Could not persist edited Google Drive pending capture', error);
        });
        addPending(uploadItem);
        queuedForRetry = true;
      }
      setEditingCapture(null);
      setStatus('Uploading edited capture to Google Drive');
      try {
        const uploaded = await uploadCaptureToGoogleDrive({ ...uploadItem, pngBase64 });
        const uploadedItem = {
          ...uploadItem,
          googleDriveFileId: uploaded.fileId,
          googleDriveUrl: uploaded.webViewLink || undefined,
          googleDriveFolderUrl: uploaded.folderViewLink || undefined,
        };
        setLastCapture(uploadedItem);
        updateCaptureRecord(uploadedItem);
        setStatus('Edited capture uploaded to Google Drive');
      } catch (error) {
        setStatus(queuedForRetry
          ? `Edited capture queued for Google Drive: ${errorMessage(error, 'Upload failed')}`
          : `Edited Google Drive upload failed: ${errorMessage(error, 'Upload failed')}`);
      }
      return;
    }

    if (replace && base.filePath) {
      const saved = await invoke<LocalCaptureSave>('overwrite_local_capture', {
        path: base.filePath,
        pngBase64,
        metadataJson: metadataForCapture(target, sourceName, operationCount),
      });
      const replaced = { ...target, filePath: saved.filePath };
      setLocalCaptures((current) => {
        const exists = current.some((item) => item.id === base.id);
        const next = exists
          ? current.map((item) => (item.id === base.id ? replaced : item))
          : [replaced, ...current];
        return next.slice(0, 80);
      });
      setLastCapture(replaced);
      setStatus('Edited image replaced current capture');
    } else {
      const saved = await invoke<LocalCaptureSave>('save_local_capture', {
        filename: sourceName,
        pngBase64,
        metadataJson: metadataForCapture(target, sourceName, operationCount),
      });
      const savedCapture = { ...target, filePath: saved.filePath };
      addLocalCapture(savedCapture);
      setLastCapture(savedCapture);
      setStatus(replace ? 'Edited image saved locally' : 'Edited image saved as new capture');
    }
    setEditingCapture(null);
  };

  const uploadCapture = async (capture: UploadableCapture): Promise<{ openUrl?: string }> => {
    if (!settingsRef.current.apiSendingEnabled) {
      throw new Error('API sending is blocked in Connection settings');
    }
    const uploadStep = async <T,>(label: string, action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        throw new Error(`${label} failed: ${errorMessage(error, 'Unknown error')}`);
      }
    };

    const token = await uploadStep('Authorize upload', captureToken);
    const pngBase64 = capture.pngBase64 || await uploadStep(
      'Read queued capture',
      () => invoke<string>('read_pending_capture', { id: capture.id })
    );
    const bytes = base64ToBytes(pngBase64);
    const platform = await platformLabel();
    const sourceName = captureFileName(new Date(capture.capturedAt), capture);
    const appName = capture.appName?.trim();
    const windowTitle = capture.windowTitle?.trim();
    const displayName = appName || windowTitle || 'Desktop';
    const extraTags = [displayName, appName, windowTitle].filter((tag): tag is string => Boolean(tag));
    const upload = await uploadStep('Create upload session', () =>
      apiPost<{
        uploadId: string;
        chunkSize: number;
      }>('/capture/assets/uploads', {
        sourceName,
        expectedSize: bytes.byteLength,
        capturedAt: capture.capturedAt,
        captureMode: capture.mode,
        width: capture.width,
        height: capture.height,
        displayWidth: capture.displayWidth,
        displayHeight: capture.displayHeight,
        scaleFactor: capture.scaleFactor,
        qualityScale: settingsRef.current.qualityScale,
        platform,
        appVersion: APP_VERSION,
        appName,
        windowTitle,
        displayName,
        tags: ['desktop', platform, ...extraTags],
      }, token)
    );

    const chunkSize = upload.chunkSize || CHUNK_SIZE;
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
    for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += chunkSize, chunkIndex += 1) {
      await uploadStep(`Upload chunk ${chunkIndex + 1}/${totalChunks}`, async () => {
        const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
        let response: Response;
        try {
          response = await fetch(apiUrl(settingsRef.current, `/capture/assets/uploads/${encodeURIComponent(upload.uploadId)}/chunks/${chunkIndex}`), {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              Authorization: `Bearer ${token}`,
            },
            body: chunk,
          });
        } catch (error) {
          throw new Error(`Could not reach Dendro API at ${apiBaseLabel(settingsRef.current)} (${errorMessage(error, 'network error')})`);
        }
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Chunk upload failed with ${response.status}`);
        }
      });
    }

    const sha256 = await sha256Hex(bytes);
    const finalized = await uploadStep('Finalize upload', () =>
      apiPost<{ openUrl?: string }>('/capture/assets/uploads/' + encodeURIComponent(upload.uploadId) + '/finalize', {
        sha256,
      }, token)
    );
    removePending(capture.id, 'dendroApi');
    if (finalized.openUrl && settingsRef.current.openAfterUpload) {
      await openOnlineImage(finalized.openUrl);
    }
    return finalized;
  };

  const openOnlineImage = async (url?: string | null): Promise<void> => {
    if (!url || !settingsRef.current.openAfterUpload) return;
    try {
      await openUrl(url);
    } catch (error) {
      console.warn('Could not open online image after upload', error);
      setStatus(`Uploaded, but could not open online image: ${errorMessage(error, 'Open failed')}`);
    }
  };

  const googleDriveCanUpload = (): boolean => {
    const drive = googleDriveRef.current;
    return settingsRef.current.captureDestination === 'googleDrive' && settingsRef.current.googleDriveUploadEnabled && drive.configured && drive.linked;
  };

  const updateGoogleDriveOcrMetadata = async (
    capture: UploadableCapture,
    pngBase64: string,
    fileId: string,
  ): Promise<void> => {
    if (!settingsRef.current.googleDriveOcrEnabled) return;
    try {
      setStatus('Google Drive upload complete, OCR running in background');
      const ocrText = await recognizeCaptureText(pngBase64);
      if (!ocrText) {
        setStatus('Google Drive upload complete, OCR found no text');
        return;
      }
      const result = await invoke<GoogleDriveOcrUpdateResult>('google_drive_update_capture_ocr', {
        payload: {
          fileId,
          captureId: capture.id,
          capturedAt: capture.capturedAt,
          mode: capture.mode,
          width: capture.width,
          height: capture.height,
          displayWidth: capture.displayWidth,
          displayHeight: capture.displayHeight,
          scaleFactor: capture.scaleFactor,
          appName: capture.appName,
          windowTitle: capture.windowTitle,
          ocrText,
        },
      });
      setStatus(result.ocrIndexed
        ? 'Google Drive OCR metadata updated'
        : 'Google Drive upload complete, OCR found no text');
    } catch (error) {
      console.warn('Google Drive background OCR failed', error);
      setStatus(`Google Drive upload complete, OCR skipped: ${errorMessage(error, 'OCR failed')}`);
    }
  };

  const uploadCaptureToGoogleDrive = async (
    capture: UploadableCapture,
  ): Promise<GoogleDriveUploadResult> => {
    if (!settingsRef.current.googleDriveUploadEnabled) {
      throw new Error('Google Drive is not selected as the capture destination');
    }
    const drive = googleDriveRef.current;
    if (!drive.configured) {
      throw new Error('Paste a Google OAuth desktop Client ID and Client Secret in Google Drive settings first');
    }
    if (!drive.linked) {
      throw new Error('Link Google Drive before uploading captures');
    }

    const pngBase64 = capture.pngBase64 || await invoke<string>('read_pending_capture', { id: capture.id });
    setStatus('Uploading capture to Google Drive');
    const result = await invoke<GoogleDriveUploadResult>('google_drive_upload_capture', {
      payload: {
        filename: captureFileName(new Date(capture.capturedAt), capture),
        dayFolderName: captureDayFolderName(new Date(capture.capturedAt)),
        pngBase64,
        captureId: capture.id,
        capturedAt: capture.capturedAt,
        mode: capture.mode,
        width: capture.width,
        height: capture.height,
        displayWidth: capture.displayWidth,
        displayHeight: capture.displayHeight,
        scaleFactor: capture.scaleFactor,
        appName: capture.appName,
        windowTitle: capture.windowTitle,
      },
    });
    removePending(capture.id, 'googleDrive');
    await openOnlineImage(result.webViewLink || result.folderViewLink);
    void updateGoogleDriveOcrMetadata(capture, pngBase64, result.fileId);
    return result;
  };

  const processCapture = async (mode: CaptureMode, capture: NativeCapture, context?: CaptureWindowContext | null) => {
    const now = new Date();
    const cleanContext = cleanCaptureContext(context);
    const item: PendingCapture = {
      id: captureId(now),
      mode,
      capturedAt: now.toISOString(),
      width: capture.width,
      height: capture.height,
      displayWidth: capture.displayWidth,
      displayHeight: capture.displayHeight,
      scaleFactor: capture.scaleFactor,
      appName: cleanContext?.appName || undefined,
      windowTitle: cleanContext?.windowTitle || undefined,
    };
    const sourceName = captureFileName(now, item);
    try {
      await invoke('copy_png_to_clipboard', { pngBase64: capture.pngBase64 });
      setStatus('Copied PNG to clipboard');
    } catch (error) {
      // A clipboard hiccup must never lose the capture itself.
      console.warn('Could not copy capture to clipboard', error);
      setStatus('Capture ready, clipboard copy failed');
    }
    setLastCaptureImage(capture.pngBase64);
    const queuedItem = {
      ...item,
      previewBase64: await capturePreviewBase64(capture.pngBase64).catch(() => undefined),
    };
    setLastCapture(queuedItem);

    const destination = settingsRef.current.captureDestination;
    const pairedForUpload = hasPairedDevice(deviceRef.current);
    const canSendToApi = destination === 'dendroApi' && pairedForUpload && settingsRef.current.apiSendingEnabled;
    const canSendToDrive = googleDriveCanUpload();
    const shouldSaveLocally = destination === 'local' || settingsRef.current.saveLocally;
    let workingItem: LocalCapture = queuedItem;
    let localSaveError: string | null = null;
    let localSaved = false;

    if (shouldSaveLocally) {
      try {
        const saved = await invoke<LocalCaptureSave>('save_local_capture', {
          filename: sourceName,
          pngBase64: capture.pngBase64,
          metadataJson: JSON.stringify({
            ...queuedItem,
            sourceName,
            appVersion: APP_VERSION,
          }),
        });
        workingItem = { ...queuedItem, filePath: saved.filePath };
        addLocalCapture(workingItem);
        setLastCapture(workingItem);
        localSaved = true;
      } catch (error) {
        localSaveError = errorMessage(error, 'Unknown error');
        console.warn('Could not save capture locally', error);
      }
    }

    if (!canSendToApi && !canSendToDrive) {
      if (localSaveError) {
        setStatus(`Copied PNG, local save failed: ${localSaveError}`);
      } else if (localSaved) {
        setStatus(destination === 'dendroApi' && pairedForUpload && !settingsRef.current.apiSendingEnabled ? 'Saved locally, API sending blocked' : 'Saved locally');
      } else if (destination === 'dendroApi' && !pairedForUpload) {
        setStatus('Copied PNG. Pair DendroCapture before uploading to Dendro API.');
      } else if (destination === 'dendroApi' && !settingsRef.current.apiSendingEnabled) {
        setStatus('Copied PNG, API sending blocked');
      } else if (destination === 'googleDrive' && (!settingsRef.current.googleDriveClientId.trim() || !settingsRef.current.googleDriveClientSecret.trim())) {
        setStatus('Copied PNG. Paste a Google OAuth Client ID and Client Secret to enable Google Drive.');
      } else if (destination === 'googleDrive' && !googleDriveRef.current.linked) {
        setStatus('Copied PNG. Link Google Drive before captures upload there.');
      } else {
        setStatus('Copied PNG to clipboard');
      }
      return;
    }

    const persistRetryCapture = async (uploadItem: PendingCapture): Promise<boolean> => {
      if (!shouldSaveLocally) return false;
      try {
        await invoke('save_pending_capture', { id: uploadItem.id, pngBase64: capture.pngBase64 });
        addPending(uploadItem);
        return true;
      } catch (error) {
        console.warn(`Could not persist ${queueDestinationLabel(uploadItem)} pending capture`, error);
        return false;
      }
    };

    const outcomes: string[] = [];
    const warnings: string[] = [];

    if (canSendToApi) {
      const apiItem: PendingCapture = { ...workingItem, destination: 'dendroApi' };
      const queuedForRetry = await persistRetryCapture(apiItem);
      setStatus('Uploading capture to Dendro API');
      try {
        const uploaded = await uploadCapture({ ...apiItem, pngBase64: capture.pngBase64 });
        if (uploaded.openUrl) {
          const uploadedItem = { ...workingItem, assetUrl: uploaded.openUrl };
          workingItem = uploadedItem;
          setLastCapture(uploadedItem);
          updateCaptureRecord(uploadedItem);
        }
        outcomes.push('uploaded to Dendro API');
      } catch (error) {
        outcomes.push(queuedForRetry ? 'queued for Dendro API' : `Dendro API failed: ${errorMessage(error, 'Upload failed')}`);
      }
    }

    if (canSendToDrive) {
      const driveItem: PendingCapture = { ...workingItem, destination: 'googleDrive' };
      const queuedForRetry = await persistRetryCapture(driveItem);
      try {
        const uploaded = await uploadCaptureToGoogleDrive({ ...driveItem, pngBase64: capture.pngBase64 });
        const uploadedItem = {
          ...workingItem,
          googleDriveFileId: uploaded.fileId,
          googleDriveUrl: uploaded.webViewLink || undefined,
          googleDriveFolderUrl: uploaded.folderViewLink || undefined,
        };
        workingItem = uploadedItem;
        setLastCapture(uploadedItem);
        updateCaptureRecord(uploadedItem);
        outcomes.push('uploaded to Google Drive');
      } catch (error) {
        outcomes.push(queuedForRetry ? 'queued for Google Drive' : `Google Drive failed: ${errorMessage(error, 'Upload failed')}`);
      }
    }

    const localPrefix = localSaveError
      ? `Local save failed: ${localSaveError}. `
      : localSaved
        ? 'Saved locally, '
        : '';
    const suffix = warnings.length ? ` (${warnings.join('; ')})` : '';
    setStatus(`${localPrefix}${outcomes.length ? outcomes.join(', ') : 'capture ready'}${suffix}`);
  };

  useEffect(() => {
    processCaptureRef.current = processCapture;
  });

  const showMainWindow = useCallback(async () => {
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(false).catch(() => undefined);
    await win.setSkipTaskbar(false).catch(() => undefined);
    await win.setDecorations(false).catch(() => undefined);
    await win.setResizable(false).catch(() => undefined);
    await win.setFullscreen(false).catch(() => undefined);
    await win.unmaximize().catch(() => undefined);
    await win.show().catch(() => undefined);
    await win.setFocus().catch(() => undefined);
  }, []);

  const hideMainWindowForCapture = useCallback(async (force = false) => {
    const win = getCurrentWindow();
    const visible = await win.isVisible().catch(() => false);
    mainWasVisibleRef.current = visible;
    if (!visible || (!force && !settingsRef.current.hideDuringCapture)) return;
    await win.setSkipTaskbar(true).catch(() => undefined);
    await win.hide().catch(() => undefined);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await win.isVisible().catch(() => false))) break;
      await wait(60);
      await win.hide().catch(() => undefined);
    }
    // Give the compositor a moment so the app is not in the snapshot.
    await wait(180);
  }, []);

  const restoreMainWindowAfterCancel = useCallback(async () => {
    if (mainWasVisibleRef.current) await showMainWindow();
  }, [showMainWindow]);

  const unregisterEscapeCancel = useCallback(async () => {
    if (!escapeRegisteredRef.current) return;
    escapeRegisteredRef.current = false;
    await unregister('Escape').catch(() => undefined);
  }, []);

  const clearAreaDeliveryWatchdog = useCallback(() => {
    if (areaDeliveryWatchdogRef.current === null) return;
    window.clearTimeout(areaDeliveryWatchdogRef.current);
    areaDeliveryWatchdogRef.current = null;
  }, []);

  const teardownAreaCapture = useCallback(async () => {
    clearAreaDeliveryWatchdog();
    areaSessionRef.current = null;
    pendingAreaPayloadRef.current = null;
    await unregisterEscapeCancel();
    const overlay = await WebviewWindow.getByLabel('capture-overlay').catch(() => null);
    await overlay?.hide().catch(() => undefined);
    await emitTo('capture-overlay', 'capture-overlay-reset', null).catch(() => undefined);
  }, [clearAreaDeliveryWatchdog, unregisterEscapeCancel]);

  const recoverStaleAreaCapture = useCallback(async (captureId: string, message: string) => {
    if (areaSessionRef.current?.captureId !== captureId) return;
    activeCaptureContextRef.current = null;
    await teardownAreaCapture();
    await restoreMainWindowAfterCancel();
    busyRef.current = null;
    setBusy(null);
    setStatus(message);
  }, [restoreMainWindowAfterCancel, teardownAreaCapture]);

  const armAreaDeliveryWatchdog = useCallback((captureId: string) => {
    clearAreaDeliveryWatchdog();
    areaDeliveryWatchdogRef.current = window.setTimeout(() => {
      void recoverStaleAreaCapture(captureId, 'The capture overlay did not start. Please try again.');
    }, 3500);
  }, [clearAreaDeliveryWatchdog, recoverStaleAreaCapture]);

  const cancelAreaCapture = useCallback(async (restoreWindow = true) => {
    if (!areaSessionRef.current) return;
    activeCaptureContextRef.current = null;
    await teardownAreaCapture();
    if (restoreWindow) await restoreMainWindowAfterCancel();
    busyRef.current = null;
    setBusy(null);
    setStatus('Area capture canceled');
  }, [restoreMainWindowAfterCancel, teardownAreaCapture]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !areaSessionRef.current) return;
      event.preventDefault();
      void cancelAreaCapture(false);
    };
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('keyup', onEscape, true);
    return () => {
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('keyup', onEscape, true);
    };
  }, [cancelAreaCapture]);

  const registerEscapeCancel = useCallback(async () => {
    if (escapeRegisteredRef.current) return;
    escapeRegisteredRef.current = true;
    try {
      // The overlay is a no-activate window (it never takes keyboard focus,
      // so the captured app is not disturbed); Escape must be global.
      await register('Escape', (event) => {
        if (event.state === 'Pressed') void cancelAreaCapture(false);
      });
    } catch {
      escapeRegisteredRef.current = false;
    }
  }, [cancelAreaCapture]);

  const ensureOverlayWindow = useCallback(async (): Promise<{ createdNow: boolean }> => {
    const existing = await WebviewWindow.getByLabel('capture-overlay').catch(() => null);
    if (existing) return { createdNow: false };
    overlayReadyRef.current = false;
    const overlay = new WebviewWindow('capture-overlay', {
      url: '/?captureOverlay=area',
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      visible: false,
      focus: false,
      focusable: false,
      shadow: false,
      backgroundColor: '#00000000',
      title: '',
    });
    await new Promise<void>((resolve, reject) => {
      void overlay.once('tauri://created', () => resolve());
      void overlay.once('tauri://error', (event) => {
        reject(new Error(typeof event.payload === 'string' ? event.payload : 'Could not open capture overlay'));
      });
    });
    void overlay.once('tauri://destroyed', () => {
      overlayReadyRef.current = false;
    });
    // Layered 254/255 alpha: browsers under the overlay keep playing video
    // because Chromium's occlusion tracker ignores translucent windows.
    await invoke('prepare_overlay_window').catch((error) => {
      console.warn('Could not configure the capture overlay window', error);
    });
    return { createdNow: true };
  }, []);

  // Warm the overlay window at startup so the first capture does not pay the
  // webview cold-start; it stays hidden and is reused for every capture.
  useEffect(() => {
    void ensureOverlayWindow().catch(() => undefined);
  }, [ensureOverlayWindow]);

  const deliverAreaSession = useCallback(async (payload: AreaSessionPayload) => {
    const overlay = await WebviewWindow.getByLabel('capture-overlay').catch(() => null);
    if (!overlay) throw new Error('Could not open capture overlay');
    await overlay.setPosition(new PhysicalPosition(payload.session.originX, payload.session.originY)).catch(() => undefined);
    await overlay.setSize(new PhysicalSize(payload.session.width, payload.session.height)).catch(() => undefined);
    // Idempotent; re-applied before each show in case the windowing layer
    // reset the layered style since creation.
    await invoke('prepare_overlay_window').catch(() => undefined);
    armAreaDeliveryWatchdog(payload.captureId);
    await emitTo('capture-overlay', 'capture-snapshot', payload).catch(() => undefined);
    const shown = await overlay.show().then(() => true).catch(() => false);
    if (!shown) {
      await recoverStaleAreaCapture(payload.captureId, 'Could not show the capture overlay. Please try again.');
      return;
    }
    setStatus('Drag an area to capture. Esc cancels');
  }, [armAreaDeliveryWatchdog, recoverStaleAreaCapture]);

  useEffect(() => {
    const subscriptions = [
      listen<string>('capture-overlay-ready', async () => {
        overlayReadyRef.current = true;
        const payload = pendingAreaPayloadRef.current;
        pendingAreaPayloadRef.current = null;
        if (payload && areaSessionRef.current?.captureId === payload.captureId) {
          await deliverAreaSession(payload);
        }
      }),
      listen<string>('capture-overlay-session-ready', (event) => {
        if (areaSessionRef.current?.captureId === event.payload) {
          clearAreaDeliveryWatchdog();
        }
      }),
      listen<CaptureCropRequestPayload>('capture-crop-request', async (event) => {
        const session = areaSessionRef.current;
        if (!session || session.captureId !== event.payload.captureId) return;
        const context = activeCaptureContextRef.current;
        activeCaptureContextRef.current = null;
        setStatus('Capturing selected area');
        // Hide the overlay before processing; normal captures crop the frozen
        // frame taken before the overlay existed, while delayed captures still
        // intentionally grab the live screen after the delay.
        await teardownAreaCapture();
        try {
          const delayMs = Math.round(clampNumber(event.payload.delayedCaptureSeconds, 0, 10) * 1000);
          let capture: NativeCapture;
          if (event.payload.liveSelection || delayMs > 0) {
            await wait(delayMs || 140);
            capture = await invoke<NativeCapture>('finish_area_capture', {
              rect: event.payload.rect,
              qualityScale: event.payload.qualityScale,
            });
          } else {
            capture = await invoke<NativeCapture>('finish_area_capture_from_snapshot', {
              session: session.session,
              rect: event.payload.rect,
              qualityScale: event.payload.qualityScale,
            });
          }
          await showMainWindow();
          busyRef.current = null;
          setBusy(null);
          setStatus('Processing capture');
          await processCaptureRef.current('area', capture, context);
        } catch (error) {
          await showMainWindow();
          busyRef.current = null;
          setBusy(null);
          setStatus(error instanceof Error ? error.message : 'Area capture failed');
        }
      }),
      listen<CaptureCancelPayload | string>('capture-cancelled', async (event) => {
        const restoreWindow = typeof event.payload === 'object' && event.payload !== null
          ? event.payload.restoreWindow !== false
          : true;
        await cancelAreaCapture(restoreWindow);
      }),
      listen<string>('capture-error', async (event) => {
        activeCaptureContextRef.current = null;
        await teardownAreaCapture();
        await restoreMainWindowAfterCancel();
        busyRef.current = null;
        setBusy(null);
        setStatus(event.payload || 'Capture failed');
      }),
    ];
    return () => {
      subscriptions.forEach((subscription) => {
        void subscription.then((unlisten) => unlisten()).catch(() => undefined);
      });
    };
  }, [cancelAreaCapture, clearAreaDeliveryWatchdog, deliverAreaSession, restoreMainWindowAfterCancel, showMainWindow, teardownAreaCapture]);

  const startAreaCapture = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = 'area';
    setBusy('area');
    setFullscreenPicker(null);
    setStatus('Opening capture overlay');
    try {
      const cursor = await cursorPosition().catch(() => null);
      const liveSelection = settingsRef.current.liveAreaSelection;
      if (liveSelection) {
        await hideMainWindowForCapture(true);
        const context = await readActiveWindowContext();
        setStatus('Drag an area to capture. Right-click before release uses the delay. Esc cancels');
        const capture = await invoke<NativeCapture>('native_area_capture', {
          cursorX: cursor ? Math.round(cursor.x) : null,
          cursorY: cursor ? Math.round(cursor.y) : null,
          qualityScale: settingsRef.current.qualityScale,
          delayedCaptureSeconds: clampNumber(settingsRef.current.delayedAreaCaptureSeconds, 0, 10),
        });
        await showMainWindow();
        busyRef.current = null;
        setBusy(null);
        setStatus('Processing capture');
        await processCapture('area', capture, context);
        return;
      }
      const overlayPromise = withTimeout(
        ensureOverlayWindow(),
        7000,
        'Could not open the capture overlay. Please try again.',
      );
      // Always hide for area captures: the app window would otherwise end up
      // inside the captured region.
      await hideMainWindowForCapture(true);
      activeCaptureContextRef.current = await readActiveWindowContext();
      const captureId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const session = await invoke<AreaCaptureSession>('begin_area_capture', {
        cursorX: cursor ? Math.round(cursor.x) : null,
        cursorY: cursor ? Math.round(cursor.y) : null,
        includeSnapshot: !liveSelection,
      });
      const { createdNow } = await overlayPromise;
      areaSessionRef.current = { captureId, session };
      const payload: AreaSessionPayload = {
        captureId,
        session,
        qualityScale: settingsRef.current.qualityScale,
        delayedCaptureSeconds: clampNumber(settingsRef.current.delayedAreaCaptureSeconds, 0, 10),
        liveSelection,
      };
      await registerEscapeCancel();
      if (!createdNow || overlayReadyRef.current) {
        await deliverAreaSession(payload);
      } else {
        // Freshly created window: its page is still booting; the
        // capture-overlay-ready listener delivers the payload.
        pendingAreaPayloadRef.current = payload;
        // Watchdog: never leave the app stuck busy and hidden if the overlay
        // page fails to boot.
        window.setTimeout(() => {
          if (pendingAreaPayloadRef.current?.captureId !== captureId) return;
          void recoverStaleAreaCapture(captureId, 'The capture overlay did not start. Please try again.');
        }, 6000);
      }
    } catch (error) {
      activeCaptureContextRef.current = null;
      await teardownAreaCapture();
      await restoreMainWindowAfterCancel();
      busyRef.current = null;
      setBusy(null);
      setStatus(error instanceof Error ? error.message : 'Area capture failed');
    }
  }, [
    deliverAreaSession,
    ensureOverlayWindow,
    hideMainWindowForCapture,
    readActiveWindowContext,
    registerEscapeCancel,
    recoverStaleAreaCapture,
    restoreMainWindowAfterCancel,
    teardownAreaCapture,
  ]);

  const openFullscreenPicker = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = 'fullscreen-picker';
    setBusy('fullscreen-picker');
    setStatus('Loading display previews');
    setFullscreenPicker({ loading: true, previews: [] });
    try {
      const previews = await withTimeout(
        invoke<MonitorPreview[]>('capture_monitor_previews', { maxWidth: 220 }),
        10000,
        'Could not load display previews. Windows screen capture did not respond.',
      );
      setFullscreenPicker({ loading: false, previews });
      setStatus('Choose a display to capture');
    } catch (error) {
      setFullscreenPicker({
        loading: false,
        previews: [],
        error: error instanceof Error ? error.message : 'Could not load display previews',
      });
      setStatus(error instanceof Error ? error.message : 'Could not load display previews');
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  const captureSelectedDisplay = async (preview: MonitorPreview) => {
    setFullscreenPicker(null);
    busyRef.current = `fullscreen-${preview.monitor.id}`;
    setBusy(`fullscreen-${preview.monitor.id}`);
    setStatus(preview.monitor.isPrimary ? 'Capturing primary display' : 'Capturing display');
    try {
      await hideMainWindowForCapture();
      await wait(240);
      const context = await readActiveWindowContext();
      const capture = await invoke<NativeCapture>('capture_display', {
        monitorId: preview.monitor.id,
        qualityScale: settingsRef.current.qualityScale,
      });
      await showMainWindow();
      busyRef.current = null;
      setBusy(null);
      setStatus('Processing capture');
      await processCapture('fullscreen', capture, context);
    } catch (error) {
      await showMainWindow();
      setStatus(error instanceof Error ? error.message : 'Fullscreen capture failed');
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  useEffect(() => {
    let alive = true;
    // All register/unregister calls are chained so a cleanup's unregisterAll
    // can never land after (and silently wipe) the next bind's registrations.
    shortcutOpsRef.current = shortcutOpsRef.current.then(async () => {
      await unregisterAll().catch(() => undefined);
      escapeRegisteredRef.current = false;
      if (!alive || recordingShortcut) return;
      const bindings: Array<[string, () => void]> = [
        [normalizedShortcut(settings.areaShortcut), () => void startAreaCapture()],
        [normalizedShortcut(settings.fullscreenShortcut), () => void openFullscreenPicker()],
      ];
      for (const [shortcut, action] of bindings) {
        await register(shortcut, (event) => {
          if (event.state === 'Pressed') action();
        }).catch(() => {
          setStatus(`Could not register ${shortcut}. It may be in use by another app`);
        });
      }
    });
    return () => {
      alive = false;
      shortcutOpsRef.current = shortcutOpsRef.current.then(async () => {
        await unregisterAll().catch(() => undefined);
        escapeRegisteredRef.current = false;
      });
    };
  }, [settings.areaShortcut, settings.fullscreenShortcut, recordingShortcut, startAreaCapture, openFullscreenPicker]);

  const retryPending = async (capture: PendingCapture) => {
    const destination = queueDestination(capture);
    if (destination === 'dendroApi') {
      if (!hasPairedDevice(deviceRef.current)) {
        setStatus('Pair DendroCapture before retrying Dendro API uploads');
        return;
      }
      if (!settingsRef.current.apiSendingEnabled) {
        setStatus('API sending is blocked in Connection settings');
        return;
      }
    } else if (!googleDriveCanUpload()) {
      setStatus('Select Google Drive, paste the OAuth Client ID and Client Secret, and link your account before retrying');
      return;
    }
    setBusy(`retry-${capture.id}`);
    setStatus(`Retrying ${queueDestinationLabel(capture)} upload`);
    try {
      if (destination === 'googleDrive') {
        const uploaded = await uploadCaptureToGoogleDrive(capture);
        updateCaptureRecord({
          ...capture,
          googleDriveFileId: uploaded.fileId,
          googleDriveUrl: uploaded.webViewLink || undefined,
          googleDriveFolderUrl: uploaded.folderViewLink || undefined,
        });
      } else {
        const uploaded = await uploadCapture(capture);
        if (uploaded.openUrl) {
          updateCaptureRecord({ ...capture, assetUrl: uploaded.openUrl });
        }
      }
      setStatus(`${queueDestinationLabel(capture)} queued capture uploaded`);
    } catch (error) {
      setStatus(errorMessage(error, 'Retry failed'));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const retryAllPending = async () => {
    let retried = 0;
    for (const capture of pending) {
      // Keep this intentionally sequential so the API and worker are not flooded.
      const destination = queueDestination(capture);
      if (destination === 'dendroApi' && (!hasPairedDevice(deviceRef.current) || !settingsRef.current.apiSendingEnabled)) continue;
      if (destination === 'googleDrive' && !googleDriveCanUpload()) continue;
      retried += 1;
      await retryPending(capture);
    }
    if (!retried) setStatus('No queued uploads are enabled for retry');
  };

  const uploadLatestCapture = async () => {
    if (!latestCapture) return;
    if (!hasPairedDevice(deviceRef.current)) {
      setStatus('Pair DendroCapture before uploading this capture');
      return;
    }
    if (!settingsRef.current.apiSendingEnabled) {
      setStatus('API sending is blocked in Connection settings');
      return;
    }
    if (busyRef.current) return;
    const item: LocalCapture = latestCapture;
    busyRef.current = `upload-${item.id}`;
    setBusy(`upload-${item.id}`);
    setPreviewMenuOpen(false);
    setStatus('Uploading current capture');
    let queuedForRetry = false;
    try {
      const pngBase64 = await originalPngForCapture(item);
      const apiItem: PendingCapture = { ...item, destination: 'dendroApi' };
      if (settingsRef.current.saveLocally) {
        await invoke('save_pending_capture', { id: apiItem.id, pngBase64 }).catch((error) => {
          console.warn('Could not persist manual upload queue item', error);
        });
        addPending(apiItem);
        queuedForRetry = true;
      }
      const uploaded = await uploadCapture({ ...apiItem, pngBase64 });
      const uploadedItem = uploaded.openUrl ? { ...item, assetUrl: uploaded.openUrl } : item;
      updateCaptureRecord(uploadedItem);
      setLastCapture(uploadedItem);
      if (item.filePath) {
        await invoke<LocalCaptureSave>('overwrite_local_capture', {
          path: item.filePath,
          pngBase64,
          metadataJson: metadataForCapture(uploadedItem, item.filePath.split(/[\\/]/).pop() || captureFileName(new Date(item.capturedAt), item)),
        }).catch((error) => {
          console.warn('Could not update local capture metadata after upload', error);
        });
      }
      setStatus('Current capture uploaded');
    } catch (error) {
      setStatus(queuedForRetry
        ? `Current capture queued: ${errorMessage(error, 'Upload failed')}`
        : `Current capture upload failed: ${errorMessage(error, 'Upload failed')}`);
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const openLatestAsset = async () => {
    const url = onlineImageUrl(latestCapture);
    setPreviewMenuOpen(false);
    if (!url) {
      setStatus('Upload this capture before opening the online image');
      return;
    }
    try {
      await openUrl(url);
      setStatus('Opened online image');
    } catch (error) {
      setStatus(errorMessage(error, 'Could not open online image'));
    }
  };

  const saveLatestCaptureLocally = async () => {
    if (!latestCapture) return;
    if (busyRef.current) return;
    const item: LocalCapture = latestCapture;
    setPreviewMenuOpen(false);
    if (item.filePath) {
      await revealCapture(item);
      return;
    }
    busyRef.current = `save-${item.id}`;
    setBusy(`save-${item.id}`);
    setStatus('Saving current capture locally');
    try {
      const pngBase64 = await originalPngForCapture(item);
      const filename = captureFileName(new Date(item.capturedAt), item);
      const saved = await invoke<LocalCaptureSave>('save_local_capture', {
        filename,
        pngBase64,
        metadataJson: metadataForCapture(item, filename),
      });
      const savedCapture = { ...item, filePath: saved.filePath };
      addLocalCapture(savedCapture);
      setLastCapture(savedCapture);
      setStatus('Current capture saved locally');
    } catch (error) {
      setStatus(errorMessage(error, 'Could not save current capture locally'));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const copyLastCapture = async () => {
    if (!lastCaptureImage) return;
    try {
      await invoke('copy_png_to_clipboard', { pngBase64: lastCaptureImage });
      setStatus('Copied last capture to clipboard');
    } catch (error) {
      setStatus(`Copy failed: ${errorMessage(error, 'Unknown error')}`);
    }
  };

  const minimizeWindow = async () => {
    await getCurrentWindow().minimize().catch(() => undefined);
  };

  const closeWindow = async () => {
    await getCurrentWindow().close().catch(() => undefined);
  };

  const openDestinationHome = async () => {
    const destination = settingsRef.current.captureDestination;
    if (destination === 'local') {
      try {
        const folderPath = await invoke<string>('local_captures_root_path');
        await openPath(folderPath);
        setStatus('Opened local captures folder');
      } catch (error) {
        setStatus(errorMessage(error, 'Could not open local captures folder'));
        setTab('settings');
        setSettingsSection('local');
      }
      return;
    }

    if (destination === 'googleDrive') {
      const drive = googleDriveRef.current;
      const url = drive.linked ? googleDriveFolderUrl(drive.folderId) : undefined;
      if (url) {
        try {
          await openUrl(url);
          setStatus('Opened Google Drive folder');
        } catch (error) {
          setStatus(errorMessage(error, 'Could not open Google Drive folder'));
        }
      } else {
        setTab('settings');
        setSettingsSection('googleDrive');
        setStatus('Link Google Drive before opening its folder');
      }
      return;
    }

    if (hasPairedDevice(deviceRef.current)) {
      const url = dendroCapturesUrl(settingsRef.current.apiBaseUrl) || DENDRO_STUDIOS_CAPTURES_URL;
      try {
        await openUrl(url);
        setStatus('Opened Dendro captures page');
      } catch (error) {
        setStatus(errorMessage(error, 'Could not open Dendro captures page'));
      }
    } else {
      setTab('settings');
      setSettingsSection('dendroApi');
      setStatus('Pair DendroCapture before opening Dendro captures');
    }
  };

  const qualityLabel = useMemo(() => `${Math.round(settings.qualityScale * 100)}%`, [settings.qualityScale]);
  const areaDelayLabel = useMemo(() => {
    const seconds = clampNumber(settings.delayedAreaCaptureSeconds, 0, 10);
    return seconds === 0 ? 'Off' : `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }, [settings.delayedAreaCaptureSeconds]);

  const navItems: Array<{ id: AppTab; label: string; icon: React.ReactNode; shortcut: string }> = [
    { id: 'capture', label: 'Capture', icon: <Crosshair size={18} />, shortcut: 'Ctrl+1' },
    { id: 'history', label: 'History', icon: <History size={18} />, shortcut: 'Ctrl+2' },
    { id: 'queue', label: 'Queue', icon: <UploadCloud size={18} />, shortcut: 'Ctrl+3' },
    { id: 'settings', label: 'Settings', icon: <Settings size={18} />, shortcut: 'Ctrl+4' },
  ];
  const settingsSections: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
    { id: 'destination', label: 'Destination', icon: <Crosshair size={15} /> },
    { id: 'local', label: 'Local', icon: <ImageIcon size={15} /> },
    { id: 'dendroApi', label: 'Dendro API', icon: <UploadCloud size={15} /> },
    { id: 'googleDrive', label: 'Google Drive', icon: <Cloud size={15} /> },
    { id: 'capture', label: 'Capture', icon: <Aperture size={15} /> },
  ];
  const latestCapture: LocalCapture | null = lastCapture || localCaptures[0] || pending[0] || null;
  const latestPreview = lastCaptureImage || latestCapture?.previewBase64;
  const pairedDevice = hasPairedDevice(device) ? device : null;
  const captureBusy = busy === 'area' || busy === 'fullscreen-picker' || !!busy?.startsWith('fullscreen-');
  const destinationLabel = captureDestinationLabel(settings.captureDestination);
  const destinationDetail = settings.captureDestination === 'local'
    ? 'local storage'
    : settings.captureDestination === 'dendroApi'
      ? 'Dendro Assets'
      : 'Google Drive';
  const destinationReady = settings.captureDestination === 'local'
    || (settings.captureDestination === 'dendroApi' && !!pairedDevice)
    || (settings.captureDestination === 'googleDrive' && googleDrive.linked);
  const topStatusLabel = settings.captureDestination === 'local'
    ? 'Local mode'
    : settings.captureDestination === 'googleDrive'
      ? googleDrive.linked ? 'Drive linked' : 'Drive not linked'
      : pairedDevice ? 'Paired' : 'Not paired';
  const connectionTitle = settings.captureDestination === 'local'
    ? 'Local mode'
    : settings.captureDestination === 'googleDrive'
      ? googleDrive.linked ? 'Google Drive linked' : 'Drive not linked'
      : pairedDevice ? 'Paired device' : 'Not paired';
  const connectionDetail = settings.captureDestination === 'local'
    ? (settings.saveLocally ? 'Saving captures locally' : 'Clipboard only')
    : settings.captureDestination === 'googleDrive'
      ? googleDrive.linked
        ? `Folder: ${googleDrive.folderName || 'DendroCapture'}`
        : 'Link Google Drive'
      : pairedDevice
        ? 'Connected to Dendro Assets'
        : 'Pair Dendro Assets';
  const statusPillLabel = settings.captureDestination === 'dendroApi' && pairedDevice
    ? settings.apiBaseUrl.replace(/^https?:\/\//, '')
    : settings.captureDestination === 'googleDrive' && googleDrive.linked
      ? googleDrive.folderName || 'DendroCapture'
      : destinationLabel;
  const historyBlockedByCloud = settings.captureDestination !== 'local' && !settings.saveLocally;
  const captureHeaderStatus = captureBusy ? status : 'Fast screenshots, instant clipboard, clean workflow.';

  return (
    <div className="dc-root">
      <div className="dc-shell">
        <header className="dc-topbar">
          <button
            type="button"
            className="dc-top-icon"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <div className="dc-top-drag-zone" data-tauri-drag-region>
            <div className="dc-top-brand" data-tauri-drag-region>
              <img src="/dendro-capture.png" alt="" />
              <strong>DendroCapture</strong>
            </div>
            <span className="dc-top-caption" data-tauri-drag-region>Screenshot to {destinationDetail}</span>
          </div>
          <div className="dc-top-spacer" />
          <button
            type="button"
            className={`dc-top-status${destinationReady ? ' paired' : ' unpaired'}`}
            onClick={() => void openDestinationHome()}
          >
            {destinationReady ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}
            <span>{topStatusLabel}</span>
          </button>
          <button type="button" className="dc-top-icon" onClick={() => setTab('settings')} aria-label="Settings">
            <Settings size={18} />
          </button>
          <div className="dc-window-controls">
            <button type="button" onClick={() => void minimizeWindow()} aria-label="Minimize DendroCapture">
              <Minus size={15} />
            </button>
            <button type="button" className="danger" onClick={() => void closeWindow()} aria-label="Close DendroCapture">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className={`dc-layout${sidebarCollapsed ? ' collapsed' : ''}`}>
          <aside className="dc-sidebar">
            <div className="dc-profile-card">
              <img src="/dendro-capture.png" alt="" />
              <span>
                <strong>DendroCapture</strong>
                <small>Screenshot to <b>{destinationDetail}</b></small>
              </span>
            </div>
            <nav className="dc-nav">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={tab === item.id ? 'active' : ''}
                  onClick={() => setTab(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  <kbd>{item.shortcut}</kbd>
                </button>
              ))}
            </nav>
            <button type="button" className={`dc-connection-card${destinationReady ? ' paired' : ' unpaired'}`} onClick={() => void openDestinationHome()}>
              <span className="dc-connection-dot" />
              <span>
                <strong>{connectionTitle}</strong>
                <small>{connectionDetail}</small>
              </span>
              <ChevronRight size={17} />
            </button>
          </aside>

          <main className="dc-main">
            <header className="dc-header">
              <div>
                <h1>{tabTitle(tab)}</h1>
                <p>{tab === 'capture' ? captureHeaderStatus : status}</p>
              </div>
              <div className="dc-status-pill">
                <Cloud size={14} />
                {statusPillLabel}
              </div>
            </header>

            {tab === 'capture' && (
              <section className="dc-capture-dashboard">
                <div className="dc-preview-panel">
                  {fullscreenPicker && (
                    <div className="dc-fullscreen-picker">
                      <div className="dc-picker-head">
                        <strong>Capture Fullscreen</strong>
                        <button type="button" onClick={() => setFullscreenPicker(null)} aria-label="Close fullscreen picker">
                          <X size={14} />
                        </button>
                      </div>
                      {fullscreenPicker.loading ? (
                        <div className="dc-picker-loading">Loading displays...</div>
                      ) : fullscreenPicker.error ? (
                        <div className="dc-picker-error">{fullscreenPicker.error}</div>
                      ) : (
                        <div className="dc-display-grid">
                          {fullscreenPicker.previews.map((preview, index) => (
                            <button
                              key={preview.monitor.id || index}
                              type="button"
                              className="dc-display-card"
                              onClick={() => void captureSelectedDisplay(preview)}
                            >
                              <img src={dataUrl(preview.pngBase64)} alt="" />
                              <span>
                                <strong>{preview.monitor.isPrimary ? 'Display 1' : `Display ${index + 1}`}</strong>
                                <small>{preview.monitor.width} x {preview.monitor.height}</small>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="dc-preview-toolbar">
                    <button
                      type="button"
                      disabled={!latestCapture || !latestPreview}
                      title="Draw"
                      onClick={() => { if (latestCapture) void openDrawEditor(latestCapture, 'latest'); }}
                    >
                      <Brush size={16} />
                    </button>
                    <button type="button" disabled={!latestPreview} title="Copy image" onClick={() => void copyLastCapture()}>
                      <Copy size={16} />
                    </button>
                    <div className="dc-preview-menu">
                      <button
                        type="button"
                        disabled={!latestCapture}
                        title="More actions"
                        onClick={() => setPreviewMenuOpen((open) => !open)}
                      >
                        <MoreVertical size={16} />
                      </button>
                      {previewMenuOpen && latestCapture ? (
                        <div className="dc-preview-menu-popover">
                          <button type="button" onClick={() => void uploadLatestCapture()} disabled={!pairedDevice || !settings.apiSendingEnabled || !!busy}>
                            <UploadCloud size={14} />
                            <span>Upload to Dendro Assets</span>
                          </button>
                          <button type="button" onClick={() => void openLatestAsset()} disabled={!onlineImageUrl(latestCapture)}>
                            <Link size={14} />
                            <span>Open online image</span>
                          </button>
                          <button type="button" onClick={() => void saveLatestCaptureLocally()} disabled={!!busy}>
                            <Download size={14} />
                            <span>{latestCapture.filePath ? 'Show local file' : 'Save locally'}</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {latestPreview ? (
                    <>
                      <div className="dc-preview-frame">
                        <div
                          className="dc-preview-image"
                          role="img"
                          aria-label="Last capture"
                          style={{ backgroundImage: `url("${dataUrl(latestPreview)}")` }}
                        />
                      </div>
                      {latestCapture && (
                        <div className="dc-preview-meta">
                          <span>{latestCapture.mode}</span>
                          <span>{latestCapture.width}x{latestCapture.height}</span>
                          <span>Copied as PNG</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="dc-empty-preview">
                      <Aperture size={44} />
                      <strong>No capture yet</strong>
                      <span>Take a screenshot to see a preview here.</span>
                    </div>
                  )}
                </div>

                <div className="dc-action-column">
                  <button type="button" className="dc-primary-action" onClick={() => void startAreaCapture()} disabled={captureBusy}>
                    <span className="dc-action-icon dc-action-image-icon">
                      <img src="/capture-area.svg" alt="" />
                    </span>
                    <span className="dc-action-copy">
                      <strong>Capture Area</strong>
                      <kbd>{settings.areaShortcut}</kbd>
                    </span>
                    <ChevronRight size={22} />
                  </button>
                  <div className="dc-action-slot">
                    <button type="button" className="dc-primary-action secondary" onClick={() => void openFullscreenPicker()} disabled={captureBusy}>
                      <span className="dc-action-icon dc-action-image-icon">
                        <img src="/capture-fullscreen.svg" alt="" />
                      </span>
                      <span className="dc-action-copy">
                        <strong>Capture Fullscreen</strong>
                        <kbd>{settings.fullscreenShortcut}</kbd>
                      </span>
                      <ChevronRight size={22} />
                    </button>
                  </div>
                </div>
              </section>
            )}

            {tab === 'history' && (
              <section className="dc-panel dc-history-panel">
                <div className="dc-panel-head">
                  <div>
                    <h2>Local History</h2>
                    <p>Captures stored on this device.</p>
                  </div>
                  <span>{`${localCaptures.length} captures`}</span>
                </div>
                {historyBlockedByCloud ? (
                  <div className="dc-empty-drop">
                    <Cloud size={36} />
                    <strong>Local history is off</strong>
                    <span>Turn on Save captures locally or choose Local as the destination.</span>
                  </div>
                ) : localCaptures.length === 0 ? (
                  <div className="dc-empty-drop">
                    <ImageIcon size={36} />
                    <strong>No local captures yet</strong>
                    <span>Use Capture Area or Capture Fullscreen with local saving enabled.</span>
                  </div>
                ) : (
                  <div className="dc-history-grid">
                    {localCaptures.map((item) => (
                      <article
                        className={`dc-history-card${item.filePath ? ' dc-clickable' : ''}`}
                        key={item.id}
                        title={item.filePath ? 'Show in folder' : undefined}
                        onClick={() => { if (item.filePath) void revealCapture(item); }}
                      >
                        {item.previewBase64 ? <img src={dataUrl(item.previewBase64)} alt="" /> : <div><ImageIcon size={24} /></div>}
                        <strong>{captureTitle(item)}</strong>
                        <small>{relativeTime(item.capturedAt)} - {item.width}x{item.height}</small>
                        {item.filePath && <code>{item.filePath}</code>}
                        <button
                          type="button"
                          className="dc-card-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            void openDrawEditor(item, 'history');
                          }}
                        >
                          <Brush size={13} />
                          Draw
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {tab === 'queue' && (
              <section className="dc-panel dc-history-panel">
                <div className="dc-panel-head">
                  <div>
                    <h2>Upload Queue</h2>
                    <p>Failed Dendro API and Google Drive uploads stored for retry.</p>
                  </div>
                  <button type="button" className="dc-btn" disabled={!pending.length || !!busy} onClick={() => void retryAllPending()}>
                    <RefreshCw size={14} />
                    Retry All
                  </button>
                </div>
                {pending.length === 0 ? (
                  <div className="dc-empty-drop">
                    <UploadCloud size={36} />
                    <strong>Queue is clear</strong>
                    <span>Local-only captures live in History instead.</span>
                  </div>
                ) : pending.map((item) => (
                  <div className="dc-queue-row" key={`${item.id}-${queueDestination(item)}`}>
                    {item.previewBase64
                      ? <img src={dataUrl(item.previewBase64)} alt="" className="dc-clickable" title="Show in folder" onClick={() => void revealCapture(item)} />
                      : <div className="dc-queue-placeholder dc-clickable" title="Show in folder" onClick={() => void revealCapture(item)}><Aperture size={16} /></div>}
                    <span>
                      <strong>{captureTitle(item)}</strong>
                      <small>{queueDestinationLabel(item)} - {item.width}x{item.height} - {relativeTime(item.capturedAt)}</small>
                    </span>
                    <button
                      type="button"
                      onClick={() => void retryPending(item)}
                      disabled={!!busy || (queueDestination(item) === 'dendroApi' ? !settings.apiSendingEnabled : !googleDriveCanUpload())}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                ))}
              </section>
            )}

            {tab === 'settings' && (
              <section className="dc-settings">
                <div className="dc-settings-tabs">
                  {settingsSections.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={settingsSection === item.id ? 'active' : ''}
                      onClick={() => setSettingsSection(item.id)}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>

                <div className="dc-settings-content">
                {settingsSection === 'destination' && (
                <div className="dc-panel dc-destination-panel">
                  <h2>Destination</h2>
                  <div className="dc-destination-grid">
                    <button
                      type="button"
                      className={`dc-destination-option${settings.captureDestination === 'local' ? ' active' : ''}`}
                      onClick={() => selectCaptureDestination('local')}
                    >
                      <ImageIcon size={18} />
                      <span>
                        <strong>Local</strong>
                        <small>Save captures on this computer.</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`dc-destination-option${settings.captureDestination === 'dendroApi' ? ' active' : ''}`}
                      onClick={() => selectCaptureDestination('dendroApi')}
                    >
                      <UploadCloud size={18} />
                      <span>
                        <strong>Dendro API</strong>
                        <small>Upload to your Dendro Assets account.</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`dc-destination-option${settings.captureDestination === 'googleDrive' ? ' active' : ''}`}
                      onClick={() => selectCaptureDestination('googleDrive')}
                    >
                      <Cloud size={18} />
                      <span>
                        <strong>Google Drive</strong>
                        <small>Upload to a DendroCapture Drive folder.</small>
                      </span>
                    </button>
                  </div>
                </div>
                )}

                {settingsSection === 'local' && (
                <div className="dc-panel">
                  <h2>Local</h2>
                  <p className="dc-muted">Local captures are written to this computer. Clipboard copy still happens even when local saving is off for cloud destinations.</p>
                  <button
                    type="button"
                    className={`dc-api-toggle ${settings.captureDestination === 'local' ? 'on' : 'off'}`}
                    onClick={() => selectCaptureDestination('local')}
                  >
                    {settings.captureDestination === 'local' ? <CheckCircle2 size={16} /> : <ImageIcon size={16} />}
                    <span>{settings.captureDestination === 'local' ? 'Local is selected' : 'Use Local destination'}</span>
                  </button>
                  <label className="dc-check dc-check-with-hint">
                    <input
                      type="checkbox"
                      checked={settings.saveLocally}
                      disabled={settings.captureDestination === 'local'}
                      onChange={(e) => updateSettings({ saveLocally: e.target.checked })}
                    />
                    <span>
                      Save captures locally
                      <small>Required for Local destination. For cloud destinations, this keeps local history and retry files.</small>
                    </span>
                  </label>
                </div>
                )}

                {settingsSection === 'dendroApi' && (
                <div className="dc-panel">
                  <h2>Dendro API</h2>
                  <label>
                    API base URL
                    <input value={settings.apiBaseUrl} onChange={(e) => updateSettings({ apiBaseUrl: e.target.value })} />
                  </label>
                  <label>
                    Device name
                    <input value={settings.deviceName} onChange={(e) => updateSettings({ deviceName: e.target.value })} />
                  </label>
                  <button
                    type="button"
                    className={`dc-api-toggle ${settings.apiSendingEnabled ? 'on' : 'off'}`}
                    onClick={() => updateSettings({ apiSendingEnabled: !settings.apiSendingEnabled })}
                  >
                    {settings.apiSendingEnabled ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                    <span>{settings.apiSendingEnabled ? 'Sending to API' : 'Blocking API sending'}</span>
                  </button>
                  <div className="dc-pair-row">
                    <input
                      placeholder="DCAP-XXXXX-XXXXX"
                      value={pairingCode}
                      onChange={(e) => setPairingCode(e.target.value)}
                    />
                    <button type="button" className="dc-btn primary" onClick={() => void pairDevice()} disabled={busy === 'pair' || !pairingCode.trim()}>
                      <ShieldCheck size={14} />
                      Pair
                    </button>
                  </div>
                  {pairedDevice ? (
                    <div className="dc-device">
                      <CheckCircle2 size={16} />
                      <span>{pairedDevice.deviceId}</span>
                    </div>
                  ) : (
                    <p className="dc-muted">Pairing is optional. Without it, captures stay local and are never uploaded.</p>
                  )}
                </div>
                )}

                {settingsSection === 'googleDrive' && (
                <div className="dc-panel">
                  <h2>Google Drive</h2>
                  <p className="dc-muted">One-time setup. No Google Drive desktop app is needed; Google only needs permission for DendroCapture to create files in your Drive.</p>
                  <p className="dc-muted">Captures are stored inside daily subfolders named dendrocapture-YYYY-MM-DD.</p>
                  <label className="dc-check dc-check-with-hint">
                    <input
                      type="checkbox"
                      checked={settings.googleDriveOcrEnabled}
                      onChange={(e) => updateSettings({ googleDriveOcrEnabled: e.target.checked })}
                    />
                    <span>
                      Enable OCR
                      <small>Uploads open immediately. OCR runs afterward and updates the Drive description/search text when it finishes.</small>
                    </span>
                  </label>
                  <div className="dc-drive-help">
                    <div className="dc-drive-steps">
                      <div className="dc-drive-step">
                        <span className="dc-drive-step-index">1</span>
                        <span className="dc-drive-step-copy">
                          <strong>Enable Google Drive API</strong>
                          <small>Open the Drive API page, choose the Google project, then click Enable if it is not enabled yet.</small>
                        </span>
                        <button type="button" className="dc-btn" onClick={() => void openUrl(GOOGLE_DRIVE_API_CONSOLE_URL)}>
                          <Cloud size={14} />
                          Open Drive API
                        </button>
                      </div>
                      <div className="dc-drive-step">
                        <span className="dc-drive-step-index">2</span>
                        <span className="dc-drive-step-copy">
                          <strong>Allow your Google account</strong>
                          <small>Open Audience before creating the client. This decides which Google accounts are allowed to connect.</small>
                          <span className="dc-drive-substeps">
                            <span>Choose External for a normal Gmail account.</span>
                            <span>If Google shows Testing, click Add users under Test users.</span>
                            <span>Add the exact Gmail account that will connect to DendroCapture, then save.</span>
                            <span>If you see 403 access_denied or validation not complete, this test user step is missing.</span>
                          </span>
                        </span>
                        <button type="button" className="dc-btn" onClick={() => void openUrl(GOOGLE_AUTH_AUDIENCE_URL)}>
                          <Users size={14} />
                          Open Audience
                        </button>
                      </div>
                      <div className="dc-drive-step">
                        <span className="dc-drive-step-index">3</span>
                        <span className="dc-drive-step-copy">
                          <strong>Create the OAuth client</strong>
                          <small>Open Clients last, then create the desktop OAuth credentials DendroCapture will use.</small>
                          <span className="dc-drive-substeps">
                            <span>Click Create client.</span>
                            <span>For Application type, choose Desktop app / Application de bureau.</span>
                            <span>For Name, enter Dendro Capture.</span>
                            <span>Click Create, then copy both the Client ID and Client Secret below.</span>
                          </span>
                        </span>
                        <button type="button" className="dc-btn primary" onClick={() => void openUrl(GOOGLE_AUTH_CLIENTS_URL)}>
                          <ShieldCheck size={14} />
                          Open Client
                        </button>
                      </div>
                    </div>
                    <p className="dc-drive-next-step">After creating the client, paste both values below, click Link Google Drive, check the Google Drive permission box, then approve the browser screen.</p>
                    <div className="dc-drive-troubleshoot">
                      <AlertTriangle size={15} />
                      <span>
                        <strong>Blocked with 403 access_denied?</strong>
                        <small>Open Audience, add the signing-in Gmail under Test users, save, wait a minute, then click Link Google Drive again.</small>
                      </span>
                    </div>
                    <div className="dc-drive-troubleshoot">
                      <AlertTriangle size={15} />
                      <span>
                        <strong>Blocked with 403 org_internal?</strong>
                        <small>Open Audience and switch the app to External. Internal only works for Google Workspace organizations.</small>
                      </span>
                    </div>
                    <small className="dc-drive-note">The browser error "validation not complete" usually means the app is in Testing and the Gmail account is not an approved test user yet.</small>
                    <small className="dc-drive-note">If Google opens any other error page instead of the permission screen, check that Drive API is enabled and the Client ID and Client Secret are copied from the same Desktop app. Google says OAuth changes can take a few minutes to a few hours to apply.</small>
                    <button type="button" className="dc-inline-link" onClick={() => void openUrl(GOOGLE_CREDENTIALS_DOCS_URL)}>
                      Google setup documentation
                    </button>
                  </div>
                  <label>
                    OAuth desktop client ID
                    <input
                      value={settings.googleDriveClientId}
                      placeholder="000000000000-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
                      spellCheck={false}
                      onChange={(e) => updateSettings({ googleDriveClientId: e.target.value })}
                    />
                  </label>
                  <label>
                    OAuth desktop client secret
                    <input
                      type="password"
                      value={settings.googleDriveClientSecret}
                      placeholder="GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => updateSettings({ googleDriveClientSecret: e.target.value })}
                    />
                  </label>
                  {googleDrive.linked ? (
                    <div className="dc-drive-status">
                      <CheckCircle2 size={16} />
                      <span>
                        <strong>{googleDrive.email || 'Google account linked'}</strong>
                        <small>Folder: {googleDrive.folderName || 'DendroCapture'}</small>
                      </span>
                    </div>
                  ) : (
                    <div className="dc-drive-status warning">
                      <AlertTriangle size={16} />
                      <span>
                        <strong>Not linked</strong>
                        <small>Paste the Client ID and Client Secret, then link Google Drive.</small>
                      </span>
                    </div>
                  )}
                  <div className="dc-drive-actions">
                    {!googleDrive.linked ? (
                      <button
                        type="button"
                        className="dc-btn primary"
                        onClick={() => void linkGoogleDrive()}
                        disabled={(!!busy && busy !== 'google-drive-link') || !settings.googleDriveClientId.trim() || !settings.googleDriveClientSecret.trim()}
                      >
                        <Cloud size={14} />
                        {busy === 'google-drive-link' ? 'Try link again' : 'Link Google Drive'}
                      </button>
                    ) : (
                      <button type="button" className="dc-btn" onClick={() => void unlinkGoogleDrive()} disabled={busy === 'google-drive-unlink'}>
                        <X size={14} />
                        Unlink
                      </button>
                    )}
                  </div>
                </div>
                )}

                {settingsSection === 'capture' && (
                <div className="dc-panel">
                  <h2>Capture</h2>
                  <label>
                    Capture Area shortcut
                    <button
                      type="button"
                      className={`dc-shortcut-recorder${recordingShortcut === 'areaShortcut' ? ' recording' : ''}`}
                      onClick={() => {
                        setRecordingShortcut('areaShortcut');
                        setStatus('Press the new Capture Area shortcut');
                      }}
                    >
                      <span>{recordingShortcut === 'areaShortcut' ? 'Press shortcut...' : settings.areaShortcut}</span>
                      <small>{recordingShortcut === 'areaShortcut' ? 'Esc cancels' : 'Click to change'}</small>
                    </button>
                  </label>
                  <label>
                    Capture Fullscreen shortcut
                    <button
                      type="button"
                      className={`dc-shortcut-recorder${recordingShortcut === 'fullscreenShortcut' ? ' recording' : ''}`}
                      onClick={() => {
                        setRecordingShortcut('fullscreenShortcut');
                        setStatus('Press the new Capture Fullscreen shortcut');
                      }}
                    >
                      <span>{recordingShortcut === 'fullscreenShortcut' ? 'Press shortcut...' : settings.fullscreenShortcut}</span>
                      <small>{recordingShortcut === 'fullscreenShortcut' ? 'Esc cancels' : 'Click to change'}</small>
                    </button>
                  </label>
                  <label>
                    Output resolution scale <b>{qualityLabel}</b>
                    <input
                      type="range"
                      min="0.25"
                      max="1"
                      step="0.05"
                      value={settings.qualityScale}
                      onChange={(e) => updateSettings({ qualityScale: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Area right-click delay <b>{areaDelayLabel}</b>
                    <input
                      type="range"
                      min="0"
                      max="10"
                      step="0.5"
                      value={settings.delayedAreaCaptureSeconds}
                      onChange={(e) => updateSettings({ delayedAreaCaptureSeconds: clampNumber(Number(e.target.value), 0, 10) })}
                    />
                  </label>
                  <label className="dc-check">
                    <input
                      type="checkbox"
                      checked={settings.openAfterUpload}
                      onChange={(e) => updateSettings({ openAfterUpload: e.target.checked })}
                    />
                    Open image online after upload
                  </label>
                  <label className="dc-check">
                    <input
                      type="checkbox"
                      checked={settings.hideDuringCapture}
                      onChange={(e) => updateSettings({ hideDuringCapture: e.target.checked })}
                    />
                    Hide DendroCapture during capture
                  </label>
                  <label className="dc-check dc-check-with-hint">
                    <input
                      type="checkbox"
                      checked={settings.liveAreaSelection}
                      onChange={(e) => updateSettings({ liveAreaSelection: e.target.checked })}
                    />
                    <span>
                      Live area selection
                      <small>Keeps videos and other media rendering while you select an area. When off, selection uses a frozen screen frame. Right-click before release to use the delay.</small>
                    </span>
                  </label>
                  <label className="dc-check">
                    <input
                      type="checkbox"
                      checked={settings.launchOnStartup}
                      onChange={(e) => updateSettings({ launchOnStartup: e.target.checked })}
                    />
                    Launch DendroCapture when the computer starts
                  </label>
                </div>
                )}
                </div>

              </section>
            )}
          </main>
        </div>
      </div>
      {editingCapture && (
        <AnnotationEditor
          imageBase64={editingCapture.imageBase64}
          title={editingCapture.title}
          replaceDefault
          onClose={() => setEditingCapture(null)}
          onSave={saveEditedCapture}
        />
      )}
    </div>
  );
};

const isCaptureOverlay = new URLSearchParams(window.location.search).get('captureOverlay') === 'area';

createRoot(document.getElementById('root')!).render(
  <BootErrorBoundary>
    {isCaptureOverlay ? <CaptureOverlayApp /> : <DendroCaptureApp />}
  </BootErrorBoundary>,
);
