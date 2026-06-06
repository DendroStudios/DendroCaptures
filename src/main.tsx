import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { currentMonitor, cursorPosition, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';
import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import {
  Aperture,
  AlertTriangle,
  ChevronRight,
  CheckCircle2,
  Clipboard,
  Cloud,
  Copy,
  Crosshair,
  Download,
  History,
  Image as ImageIcon,
  Link,
  MoreVertical,
  Minus,
  RefreshCw,
  Settings,
  UploadCloud,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import './styles.css';

type CaptureMode = 'area' | 'fullscreen';
type AppTab = 'capture' | 'history' | 'queue' | 'settings';
type ShortcutField = 'areaShortcut' | 'fullscreenShortcut';

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

interface CropRect {
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
  deviceName: string;
  openAfterUpload: boolean;
  hideDuringCapture: boolean;
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
}

type UploadableCapture = PendingCapture & { pngBase64?: string };

interface LocalCapture extends PendingCapture {
  filePath?: string;
}

interface LocalCaptureSave {
  filePath: string;
}

interface CaptureWindowContext {
  appName?: string | null;
  windowTitle?: string | null;
}

interface DeviceState {
  deviceId: string;
  publicKey: string;
}

interface CaptureResultPayload {
  mode: CaptureMode;
  capture: NativeCapture;
}

interface CaptureRegionRequestPayload {
  rect: CaptureRegionRect;
  qualityScale: number;
}

interface CaptureSnapshotPayload {
  captureId: string;
  capture: NativeCapture;
}

interface CaptureCropRequestPayload {
  captureId: string;
  rect: CropRect;
  qualityScale: number;
}

const APP_VERSION = '0.1.20';
const SETTINGS_KEY = 'dendro-capture:settings';
const DEVICE_KEY = 'dendro-capture:device';
const PENDING_KEY = 'dendro-capture:pending';
const LOCAL_CAPTURES_KEY = 'dendro-capture:local-captures';
const CHUNK_SIZE = 8 * 1024 * 1024;
const MIN_APP_WIDTH = 740;
const MIN_APP_HEIGHT = 500;
const MAX_APP_WIDTH = 980;
const MAX_APP_HEIGHT = 640;

const defaultSettings: CaptureSettings = {
  apiBaseUrl: 'http://localhost:3001/api',
  areaShortcut: 'Alt+Shift+4',
  fullscreenShortcut: 'Alt+Shift+5',
  qualityScale: 1,
  deviceName: 'DendroCapture Desktop',
  openAfterUpload: true,
  hideDuringCapture: true,
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
      };
    })
    .slice(0, 20);

const normalizeStoredCapture = (item: Partial<LocalCapture> | Partial<PendingCapture>): PendingCapture | null => {
  if (typeof item.id !== 'string' || typeof item.mode !== 'string') return null;
  const mode: CaptureMode = item.mode === 'fullscreen' ? 'fullscreen' : 'area';
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
  };
};

const loadLocalCaptures = (): LocalCapture[] => {
  const captures: LocalCapture[] = [];
  for (const item of loadJson<Array<Partial<LocalCapture>>>(LOCAL_CAPTURES_KEY, [])) {
    const capture = normalizeStoredCapture(item);
    if (!capture) continue;
    captures.push({
      ...capture,
      ...(typeof item.filePath === 'string' ? { filePath: item.filePath } : {}),
    });
  }
  return captures.slice(0, 80);
};

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

const captureFileName = (date: Date): string =>
  `dendro-capture-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.png`;

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

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

const overlayNumberParam = (params: URLSearchParams, key: string, fallback: number): number => {
  const parsed = Number(params.get(key));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const CaptureOverlayApp = () => {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const captureId = params.get('captureId') || 'area';
  const qualityScale = overlayNumberParam(params, 'qualityScale', 1);
  const [snapshot, setSnapshot] = useState<NativeCapture | null>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    document.body.classList.add('dc-capture-overlay-body');
    return () => document.body.classList.remove('dc-capture-overlay-body');
  }, []);

  useEffect(() => {
    let unlistenSnapshot: (() => void) | null = null;
    let mounted = true;

    const boot = async () => {
      unlistenSnapshot = await listen<CaptureSnapshotPayload>('capture-snapshot', (event) => {
        if (event.payload.captureId === captureId) setSnapshot(event.payload.capture);
      });
      if (mounted) await emitTo('main', 'capture-overlay-ready', captureId);
    };

    void boot();
    return () => {
      mounted = false;
      unlistenSnapshot?.();
    };
  }, [captureId]);

  const closeOverlay = useCallback(async () => {
    await getCurrentWindow().close().catch(() => undefined);
  }, []);

  const cancelOverlay = useCallback(async () => {
    await emitTo('main', 'capture-cancelled', 'area');
    await closeOverlay();
  }, [closeOverlay]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void cancelOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
    if (!selectionBox || finishing || !snapshot) return;
    if (selectionBox.width < 8 || selectionBox.height < 8) {
      await cancelOverlay();
      return;
    }

    setFinishing(true);
    const scaleX = snapshot.displayWidth / Math.max(1, window.innerWidth);
    const scaleY = snapshot.displayHeight / Math.max(1, window.innerHeight);
    const rect: CaptureRegionRect = {
      x: snapshot.originX + Math.max(0, Math.round(selectionBox.left * scaleX)),
      y: snapshot.originY + Math.max(0, Math.round(selectionBox.top * scaleY)),
      width: Math.max(1, Math.round(selectionBox.width * scaleX)),
      height: Math.max(1, Math.round(selectionBox.height * scaleY)),
    };

    try {
      await emitTo('main', 'capture-region-request', { rect, qualityScale } satisfies CaptureRegionRequestPayload);
      await closeOverlay();
    } catch (error) {
      await emitTo('main', 'capture-error', error instanceof Error ? error.message : 'Area capture failed');
      await closeOverlay();
    }
  };

  return (
    <div
      className={`dc-capture-overlay-root${finishing ? ' finishing' : ''}`}
      onPointerDown={(event) => {
        if (finishing || !snapshot) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = clampPoint(event);
        setStart(point);
        setCurrent(point);
        setPointer(point);
      }}
      onPointerMove={(event) => {
        if (finishing || !snapshot) return;
        const point = clampPoint(event);
        setPointer(point);
        if (start) setCurrent(point);
      }}
      onPointerUp={() => void finishSelection()}
      onDragStart={(event) => event.preventDefault()}
    >
      {!selectionBox && <div className="dc-overlay-soft-dim" />}
      {(!snapshot || !start) && (
        <div className="dc-overlay-hud">
          <strong>{finishing ? 'Capturing' : 'Capture area'}</strong>
          <span>{finishing ? 'Saving selection...' : snapshot ? 'Drag to select. Esc cancels.' : 'Preparing screen snapshot...'}</span>
        </div>
      )}
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
          <span>{Math.round(selectionBox.width)} x {Math.round(selectionBox.height)}</span>
        </div>
      )}
      <button
        type="button"
        className="dc-overlay-cancel"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => void cancelOverlay()}
      >
        <X size={16} />
        Cancel
      </button>
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
  const [settings, setSettings] = useState<CaptureSettings>(() => loadJson(SETTINGS_KEY, defaultSettings));
  const [device, setDevice] = useState<DeviceState | null>(() => loadJson<DeviceState | null>(DEVICE_KEY, null));
  const [pending, setPending] = useState<PendingCapture[]>(loadPendingQueue);
  const [localCaptures, setLocalCaptures] = useState<LocalCapture[]>(loadLocalCaptures);
  const [tab, setTab] = useState<AppTab>('capture');
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('Ready');
  const [lastCapture, setLastCapture] = useState<PendingCapture | null>(null);
  const [lastCaptureImage, setLastCaptureImage] = useState<string | null>(null);
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutField | null>(null);
  const [fullscreenPicker, setFullscreenPicker] = useState<{
    loading: boolean;
    previews: MonitorPreview[];
    error?: string;
  } | null>(null);
  const settingsRef = useRef(settings);
  const deviceRef = useRef(device);
  const busyRef = useRef<string | null>(busy);
  const fitWindowTimerRef = useRef<number | null>(null);
  const areaSnapshotRef = useRef<CaptureSnapshotPayload | null>(null);
  const activeCaptureContextRef = useRef<CaptureWindowContext | null>(null);
  const lastExternalContextRef = useRef<CaptureWindowContext | null>(null);
  const processCaptureRef = useRef<(
    mode: CaptureMode,
    capture: NativeCapture,
    context?: CaptureWindowContext | null
  ) => Promise<void>>(async () => undefined);

  useEffect(() => {
    const recoverWindow = async () => {
      const win = getCurrentWindow();
      await win.setFullscreen(false).catch(() => undefined);
      await win.setAlwaysOnTop(false).catch(() => undefined);
      await win.setSkipTaskbar(false).catch(() => undefined);
      await win.setDecorations(false).catch(() => undefined);
      await win.setResizable(false).catch(() => undefined);
      await win.unmaximize().catch(() => undefined);
      await win.show().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
    };
    void recoverWindow();
  }, []);

  const fitWindowToCurrentMonitor = useCallback(async () => {
    const win = getCurrentWindow();
    const monitor = await currentMonitor().catch(() => null);
    const scaleFactor = monitor?.scaleFactor || 1;
    const workWidth = monitor ? monitor.workArea.size.width / scaleFactor : 1440;
    const workHeight = monitor ? monitor.workArea.size.height / scaleFactor : 900;
    const width = Math.round(clampNumber(Math.min(workWidth - 32, workWidth * 0.52), MIN_APP_WIDTH, MAX_APP_WIDTH));
    const height = Math.round(clampNumber(Math.min(workHeight - 32, workHeight * 0.62), MIN_APP_HEIGHT, MAX_APP_HEIGHT));
    await win.setResizable(false).catch(() => undefined);
    await win.setSize(new LogicalSize(width, height)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlistenMoved: (() => void) | null = null;
    let unlistenScale: (() => void) | null = null;

    const scheduleFit = () => {
      if (fitWindowTimerRef.current !== null) window.clearTimeout(fitWindowTimerRef.current);
      fitWindowTimerRef.current = window.setTimeout(() => {
        fitWindowTimerRef.current = null;
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
    settingsRef.current = settings;
    saveJson(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    deviceRef.current = device;
    if (device) saveJson(DEVICE_KEY, device);
    else localStorage.removeItem(DEVICE_KEY);
  }, [device]);

  useEffect(() => {
    saveJson(PENDING_KEY, pending.slice(0, 20));
  }, [pending]);

  useEffect(() => {
    saveJson(LOCAL_CAPTURES_KEY, localCaptures.slice(0, 80));
  }, [localCaptures]);

  const updateSettings = (patch: Partial<CaptureSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
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
      const reason = error instanceof Error && error.message ? ` (${error.message})` : '';
      throw new Error(`Could not reach Dendro API at ${apiBaseLabel(settingsRef.current)}${reason}. Check the API URL, server deployment, and capture CORS origins.`);
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
      setStatus(error instanceof Error ? error.message : 'Pairing failed');
    } finally {
      setBusy(null);
    }
  };

  const captureToken = async (): Promise<string> => {
    const currentDevice = deviceRef.current;
    if (!currentDevice) throw new Error('Pair DendroCapture before uploading');
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

  const addPending = (capture: PendingCapture) => {
    setPending((current) => [capture, ...current.filter((item) => item.id !== capture.id)].slice(0, 20));
  };

  const removePending = (id: string) => {
    setPending((current) => current.filter((item) => item.id !== id));
  };

  const addLocalCapture = (capture: LocalCapture) => {
    setLocalCaptures((current) => [capture, ...current.filter((item) => item.id !== capture.id)].slice(0, 80));
  };

  const uploadCapture = async (capture: UploadableCapture) => {
    const token = await captureToken();
    const pngBase64 = capture.pngBase64 || await invoke<string>('read_pending_capture', { id: capture.id });
    const bytes = base64ToBytes(pngBase64);
    const platform = await platformLabel();
    const sourceName = captureFileName(new Date(capture.capturedAt));
    const appName = capture.appName?.trim();
    const windowTitle = capture.windowTitle?.trim();
    const displayName = appName || windowTitle || 'Desktop';
    const extraTags = [displayName, appName, windowTitle].filter((tag): tag is string => Boolean(tag));
    const upload = await apiPost<{
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
    }, token);

    const chunkSize = upload.chunkSize || CHUNK_SIZE;
    for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += chunkSize, chunkIndex += 1) {
      const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
      const response = await fetch(apiUrl(settingsRef.current, `/capture/assets/uploads/${encodeURIComponent(upload.uploadId)}/chunks/${chunkIndex}`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${token}`,
        },
        body: chunk,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Chunk upload failed with ${response.status}`);
      }
    }

    const sha256 = await sha256Hex(bytes);
    const finalized = await apiPost<{ openUrl?: string }>('/capture/assets/uploads/' + encodeURIComponent(upload.uploadId) + '/finalize', {
      sha256,
    }, token);
    removePending(capture.id);
    await invoke('delete_pending_capture', { id: capture.id }).catch(() => undefined);
    if (finalized.openUrl && settingsRef.current.openAfterUpload) {
      await openUrl(finalized.openUrl);
    }
  };

  const processCapture = async (mode: CaptureMode, capture: NativeCapture, context?: CaptureWindowContext | null) => {
    const now = new Date();
    const cleanContext = cleanCaptureContext(context);
    const sourceName = captureFileName(now);
    const item: PendingCapture = {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2)}`,
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
    setStatus('Copied PNG to clipboard');
    await invoke('copy_png_to_clipboard', { pngBase64: capture.pngBase64 });
    setLastCaptureImage(capture.pngBase64);
    const queuedItem = {
      ...item,
      previewBase64: await capturePreviewBase64(capture.pngBase64).catch(() => undefined),
    };
    setLastCapture(queuedItem);
    if (!deviceRef.current) {
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
        addLocalCapture({ ...queuedItem, filePath: saved.filePath });
        setStatus('Saved locally');
      } catch (error) {
        addLocalCapture(queuedItem);
        setStatus(error instanceof Error ? `Copied PNG, local save failed: ${error.message}` : 'Copied PNG locally');
      }
      return;
    }
    await invoke('save_pending_capture', { id: queuedItem.id, pngBase64: capture.pngBase64 }).catch((error) => {
      console.warn('Could not persist pending capture', error);
    });
    addPending(queuedItem);
    setStatus('Uploading capture');
    try {
      await uploadCapture({ ...queuedItem, pngBase64: capture.pngBase64 });
      setStatus('Capture uploaded');
    } catch (error) {
      setStatus(error instanceof Error ? `Queued: ${error.message}` : 'Upload failed and was queued');
    }
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

  const hideMainWindowForCapture = useCallback(async () => {
    if (!settingsRef.current.hideDuringCapture) return;
    const win = getCurrentWindow();
    await win.setSkipTaskbar(true).catch(() => undefined);
    await win.hide().catch(() => undefined);
  }, []);

  useEffect(() => {
    const subscriptions = [
      listen<CaptureResultPayload>('capture-result', async (event) => {
        await showMainWindow();
        setBusy(null);
        setStatus('Processing capture');
        const context = activeCaptureContextRef.current;
        activeCaptureContextRef.current = null;
        await processCaptureRef.current(event.payload.mode, event.payload.capture, context);
      }),
      listen<CaptureRegionRequestPayload>('capture-region-request', async (event) => {
        setStatus('Capturing selected area');
        const context = activeCaptureContextRef.current;
        activeCaptureContextRef.current = null;
        try {
          await wait(220);
          const capture = await invoke<NativeCapture>('capture_region', {
            rect: event.payload.rect,
            qualityScale: event.payload.qualityScale,
          });
          await showMainWindow();
          setBusy(null);
          setStatus('Processing capture');
          await processCaptureRef.current('area', capture, context);
        } catch (error) {
          await showMainWindow();
          setBusy(null);
          setStatus(error instanceof Error ? error.message : 'Area capture failed');
        }
      }),
      listen<string>('capture-overlay-ready', async (event) => {
        const snapshot = areaSnapshotRef.current;
        if (!snapshot || snapshot.captureId !== event.payload) return;
        await emitTo('capture-overlay', 'capture-snapshot', snapshot).catch(() => undefined);
      }),
      listen<CaptureCropRequestPayload>('capture-crop-request', async (event) => {
        setStatus('Cropping selected area');
        const snapshot = areaSnapshotRef.current;
        areaSnapshotRef.current = null;
        const context = activeCaptureContextRef.current;
        activeCaptureContextRef.current = null;
        try {
          if (!snapshot || snapshot.captureId !== event.payload.captureId) {
            throw new Error('Capture snapshot expired. Please try again.');
          }

          await wait(80);
          const capture = await invoke<NativeCapture>('crop_capture', {
            pngBase64: snapshot.capture.pngBase64,
            rect: event.payload.rect,
            qualityScale: event.payload.qualityScale,
          });
          await showMainWindow();
          setBusy(null);
          setStatus('Processing capture');
          await processCaptureRef.current('area', capture, context);
        } catch (error) {
          await showMainWindow();
          setBusy(null);
          setStatus(error instanceof Error ? error.message : 'Area capture failed');
        }
      }),
      listen<string>('capture-cancelled', async () => {
        areaSnapshotRef.current = null;
        activeCaptureContextRef.current = null;
        await showMainWindow();
        setBusy(null);
        setStatus('Area capture canceled');
      }),
      listen<string>('capture-error', async (event) => {
        areaSnapshotRef.current = null;
        activeCaptureContextRef.current = null;
        await showMainWindow();
        setBusy(null);
        setStatus(event.payload || 'Capture failed');
      }),
    ];
    return () => {
      subscriptions.forEach((subscription) => {
        void subscription.then((unlisten) => unlisten()).catch(() => undefined);
      });
    };
  }, [showMainWindow]);

  const startAreaCapture = useCallback(async () => {
    if (busyRef.current) return;
    setBusy('area');
    setFullscreenPicker(null);
    setStatus('Opening capture overlay');
    try {
      const staleOverlay = await WebviewWindow.getByLabel('capture-overlay').catch(() => null);
      const cursor = await cursorPosition().catch(() => null);
      await staleOverlay?.close().catch(() => undefined);
      await hideMainWindowForCapture();
      await wait(260);
      activeCaptureContextRef.current = await readActiveWindowContext();
      const snapshot = await invoke<NativeCapture>('prepare_area_overlay_for_point', {
        cursorX: cursor ? Math.round(cursor.x) : null,
        cursorY: cursor ? Math.round(cursor.y) : null,
      });
      const captureId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      areaSnapshotRef.current = { captureId, capture: snapshot };
      const params = new URLSearchParams({
        captureOverlay: 'area',
        captureId,
        qualityScale: String(settingsRef.current.qualityScale),
      });
      const overlayWindow = new WebviewWindow('capture-overlay', {
        url: `/?${params.toString()}`,
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
        shadow: false,
        title: 'DendroCapture Area',
      });
      overlayWindow.once('tauri://created', async () => {
        await overlayWindow.setPosition(new PhysicalPosition(snapshot.originX, snapshot.originY)).catch(() => undefined);
        await overlayWindow.setSize(new PhysicalSize(snapshot.displayWidth, snapshot.displayHeight)).catch(() => undefined);
        await overlayWindow.show().catch(() => undefined);
        await overlayWindow.setFocus().catch(() => undefined);
        setStatus('Drag an area to capture');
      });
      overlayWindow.once('tauri://error', async (event) => {
        areaSnapshotRef.current = null;
        activeCaptureContextRef.current = null;
        await showMainWindow();
        setBusy(null);
        setStatus(typeof event.payload === 'string' ? event.payload : 'Could not open capture overlay');
      });
    } catch (error) {
      areaSnapshotRef.current = null;
      activeCaptureContextRef.current = null;
      await showMainWindow();
      setStatus(error instanceof Error ? error.message : 'Area capture failed');
      setBusy(null);
    }
  }, [hideMainWindowForCapture, readActiveWindowContext, showMainWindow]);

  const openFullscreenPicker = useCallback(async () => {
    if (busyRef.current) return;
    setBusy('fullscreen-picker');
    setStatus('Loading display previews');
    setFullscreenPicker({ loading: true, previews: [] });
    try {
      const previews = await invoke<MonitorPreview[]>('capture_monitor_previews', { maxWidth: 220 });
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
      setBusy(null);
    }
  }, []);

  const captureSelectedDisplay = async (preview: MonitorPreview) => {
    setFullscreenPicker(null);
    setBusy(`fullscreen-${preview.monitor.id}`);
    setStatus(preview.monitor.isPrimary ? 'Capturing primary display' : 'Capturing display');
    try {
      await hideMainWindowForCapture();
      await wait(420);
      const context = await readActiveWindowContext();
      await wait(120);
      const capture = await invoke<NativeCapture>('capture_display', {
        monitorId: preview.monitor.id,
        qualityScale: settingsRef.current.qualityScale,
      });
      await showMainWindow();
      await processCapture('fullscreen', capture, context);
    } catch (error) {
      await showMainWindow();
      setStatus(error instanceof Error ? error.message : 'Fullscreen capture failed');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    let alive = true;
    const bind = async () => {
      await unregisterAll().catch(() => undefined);
      if (recordingShortcut) return;
      if (!alive) return;
      await register(normalizedShortcut(settings.areaShortcut), () => void startAreaCapture()).catch(() => undefined);
      await register(normalizedShortcut(settings.fullscreenShortcut), () => void openFullscreenPicker()).catch(() => undefined);
    };
    void bind();
    return () => {
      alive = false;
      void unregisterAll().catch(() => undefined);
    };
  }, [settings.areaShortcut, settings.fullscreenShortcut, recordingShortcut, startAreaCapture, openFullscreenPicker]);

  const retryPending = async (capture: PendingCapture) => {
    if (!deviceRef.current) {
      setStatus('Pair DendroCapture before retrying queued uploads');
      return;
    }
    setBusy(`retry-${capture.id}`);
    setStatus('Retrying upload');
    try {
      await uploadCapture(capture);
      setStatus('Queued capture uploaded');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Retry failed');
    } finally {
      setBusy(null);
    }
  };

  const retryAllPending = async () => {
    if (!deviceRef.current) {
      setStatus('Pair DendroCapture before retrying queued uploads');
      return;
    }
    for (const capture of pending) {
      // Keep this intentionally sequential so the API and worker are not flooded.
      await retryPending(capture);
    }
  };

  const copyLastCapture = async () => {
    if (!lastCaptureImage) return;
    await invoke('copy_png_to_clipboard', { pngBase64: lastCaptureImage });
    setStatus('Copied last capture to clipboard');
  };

  const minimizeWindow = async () => {
    await getCurrentWindow().minimize().catch(() => undefined);
  };

  const closeWindow = async () => {
    await getCurrentWindow().close().catch(() => undefined);
  };

  const qualityLabel = useMemo(() => `${Math.round(settings.qualityScale * 100)}%`, [settings.qualityScale]);

  const navItems: Array<{ id: AppTab; label: string; icon: React.ReactNode; shortcut: string }> = [
    { id: 'capture', label: 'Capture', icon: <Crosshair size={18} />, shortcut: 'Ctrl+1' },
    { id: 'history', label: 'History', icon: <History size={18} />, shortcut: 'Ctrl+2' },
    { id: 'queue', label: 'Queue', icon: <UploadCloud size={18} />, shortcut: 'Ctrl+3' },
    { id: 'settings', label: 'Settings', icon: <Settings size={18} />, shortcut: 'Ctrl+4' },
  ];
  const latestCapture = lastCapture || localCaptures[0] || pending[0] || null;
  const latestPreview = lastCaptureImage || latestCapture?.previewBase64;

  return (
    <div className="dc-root">
      <div className="dc-shell">
        <header className="dc-topbar">
          <div className="dc-top-drag-zone" data-tauri-drag-region>
            <div className="dc-top-brand" data-tauri-drag-region>
              <img src="/dendro-capture.png" alt="" />
              <strong>DendroCapture</strong>
            </div>
            <span className="dc-top-caption" data-tauri-drag-region>Screenshot to Dendro Assets</span>
          </div>
          <div className="dc-top-spacer" />
          <button
            type="button"
            className={`dc-top-status${device ? ' paired' : ' unpaired'}`}
            onClick={() => setTab('settings')}
          >
            {device ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}
            <span>{device ? 'Paired' : 'Not paired'}</span>
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

        <div className="dc-layout">
          <aside className="dc-sidebar">
            <div className="dc-profile-card">
              <img src="/dendro-capture.png" alt="" />
              <span>
                <strong>DendroCapture</strong>
                <small>Screenshot to <b>{device ? 'Dendro Assets' : 'local storage'}</b></small>
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
            <button type="button" className={`dc-connection-card${device ? ' paired' : ' unpaired'}`} onClick={() => setTab('settings')}>
              <span className="dc-connection-dot" />
              <span>
                <strong>{device ? 'Paired device' : 'Not paired'}</strong>
                <small>{device ? 'Connected to Dendro Assets' : 'Saving captures locally'}</small>
              </span>
              <ChevronRight size={17} />
            </button>
          </aside>

          <main className="dc-main">
            <header className="dc-header">
              <div>
                <h1>{tabTitle(tab)}</h1>
                <p>{tab === 'capture' ? 'Fast screenshots, instant clipboard, clean workflow.' : status}</p>
              </div>
              <div className="dc-status-pill">
                <Cloud size={14} />
                {device ? settings.apiBaseUrl.replace(/^https?:\/\//, '') : 'Local mode'}
              </div>
            </header>

            {tab === 'capture' && (
              <section className="dc-capture-dashboard">
                <div className="dc-action-column">
                  <button type="button" className="dc-primary-action" onClick={() => void startAreaCapture()} disabled={!!busy}>
                    <span className="dc-action-icon dc-action-image-icon">
                      <img src="/capture-area-icon.png" alt="" />
                    </span>
                    <span className="dc-action-copy">
                      <strong>Capture Area</strong>
                      <kbd>{settings.areaShortcut}</kbd>
                    </span>
                    <ChevronRight size={22} />
                  </button>
                  <div className="dc-action-slot">
                    <button type="button" className="dc-primary-action secondary" onClick={() => void openFullscreenPicker()} disabled={!!busy}>
                      <span className="dc-action-icon dc-action-image-icon">
                        <img src="/capture-fullscreen-icon.png" alt="" />
                      </span>
                      <span className="dc-action-copy">
                        <strong>Capture Fullscreen</strong>
                        <kbd>{settings.fullscreenShortcut}</kbd>
                      </span>
                      <ChevronRight size={22} />
                    </button>
                  </div>
                </div>

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
                    <button type="button" disabled={!latestPreview} title="Copy image" onClick={() => void copyLastCapture()}>
                      <Copy size={16} />
                    </button>
                    <button type="button" disabled={!device} title="Open uploaded asset">
                      <Link size={16} />
                    </button>
                    <button type="button" disabled={!latestPreview} title="Saved locally">
                      <Download size={16} />
                    </button>
                    <button type="button" disabled title="More">
                      <MoreVertical size={16} />
                    </button>
                  </div>
                  {latestPreview ? (
                    <>
                      <img src={dataUrl(latestPreview)} alt="Last capture" />
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

                <section className="dc-panel dc-queue-card">
                  <div className="dc-panel-head">
                    <div>
                      <h2>Queue</h2>
                      <p>Failed uploads are kept here until you retry them.</p>
                    </div>
                    <span>{pending.length} pending</span>
                    <button type="button" className="dc-btn" disabled={!pending.length || !!busy} onClick={() => void retryAllPending()}>
                      <RefreshCw size={14} />
                      Retry All
                    </button>
                  </div>
                  {pending.length === 0 ? (
                    <div className="dc-empty-drop">
                      <UploadCloud size={36} />
                      <strong>No pending uploads</strong>
                      <span>Captures will appear here if an upload fails.</span>
                    </div>
                  ) : pending.slice(0, 3).map((item) => (
                    <div className="dc-queue-row" key={item.id}>
                      {item.previewBase64 ? <img src={dataUrl(item.previewBase64)} alt="" /> : <div className="dc-queue-placeholder"><Aperture size={16} /></div>}
                      <span>
                        <strong>{captureTitle(item)}</strong>
                        <small>{item.width}x{item.height} - {relativeTime(item.capturedAt)}</small>
                      </span>
                      <button type="button" onClick={() => void retryPending(item)} disabled={busy === `retry-${item.id}`}>
                        <RefreshCw size={14} />
                      </button>
                    </div>
                  ))}
                </section>

              </section>
            )}

            {tab === 'history' && (
              <section className="dc-panel dc-history-panel">
                <div className="dc-panel-head">
                  <div>
                    <h2>Local History</h2>
                    <p>Unpaired captures are saved locally and kept out of Dendro Assets.</p>
                  </div>
                  <span>{localCaptures.length} saved</span>
                </div>
                {localCaptures.length === 0 ? (
                  <div className="dc-empty-drop">
                    <ImageIcon size={36} />
                    <strong>No local captures yet</strong>
                    <span>Use Capture Area or Capture Fullscreen while unpaired.</span>
                  </div>
                ) : (
                  <div className="dc-history-grid">
                    {localCaptures.map((item) => (
                      <article className="dc-history-card" key={item.id}>
                        {item.previewBase64 ? <img src={dataUrl(item.previewBase64)} alt="" /> : <div><ImageIcon size={24} /></div>}
                        <strong>{captureTitle(item)}</strong>
                        <small>{relativeTime(item.capturedAt)} - {item.width}x{item.height}</small>
                        {item.filePath && <code>{item.filePath}</code>}
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
                    <p>Only paired uploads that fail are stored here for retry.</p>
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
                  <div className="dc-queue-row" key={item.id}>
                    {item.previewBase64 ? <img src={dataUrl(item.previewBase64)} alt="" /> : <div className="dc-queue-placeholder"><Aperture size={16} /></div>}
                    <span>
                      <strong>{captureTitle(item)}</strong>
                      <small>{item.width}x{item.height} - {relativeTime(item.capturedAt)}</small>
                    </span>
                    <button type="button" onClick={() => void retryPending(item)} disabled={busy === `retry-${item.id}`}>
                      <RefreshCw size={14} />
                    </button>
                  </div>
                ))}
              </section>
            )}

            {tab === 'settings' && (
              <section className="dc-settings">
                <div className="dc-panel">
                  <h2>Connection</h2>
                  <label>
                    API base URL
                    <input value={settings.apiBaseUrl} onChange={(e) => updateSettings({ apiBaseUrl: e.target.value })} />
                  </label>
                  <label>
                    Device name
                    <input value={settings.deviceName} onChange={(e) => updateSettings({ deviceName: e.target.value })} />
                  </label>
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
                  {device ? (
                    <div className="dc-device">
                      <CheckCircle2 size={16} />
                      <span>{device.deviceId}</span>
                    </div>
                  ) : (
                    <p className="dc-muted">Pairing is optional. Without it, captures stay local and are never uploaded.</p>
                  )}
                </div>

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
                  <label className="dc-check">
                    <input
                      type="checkbox"
                      checked={settings.openAfterUpload}
                      onChange={(e) => updateSettings({ openAfterUpload: e.target.checked })}
                    />
                    Open DendroWebsite after upload
                  </label>
                  <label className="dc-check">
                    <input
                      type="checkbox"
                      checked={settings.hideDuringCapture}
                      onChange={(e) => updateSettings({ hideDuringCapture: e.target.checked })}
                    />
                    Hide DendroCapture during capture
                  </label>
                </div>

                <div className="dc-panel dc-notes">
                  <h2>Stored Metadata</h2>
                  <p><Sparkles size={14} /> Local captures store date, resolution, active app, window title, mode, quality, and platform metadata.</p>
                  <p><Clipboard size={14} /> The PNG is copied to the system clipboard before upload or local save finishes.</p>
                  <p><Cloud size={14} /> Paired uploads go to DendroWebsite API, then the VPS uses the existing HMAC Mac worker flow.</p>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};

const isCaptureOverlay = new URLSearchParams(window.location.search).get('captureOverlay') === 'area';

createRoot(document.getElementById('root')!).render(
  <BootErrorBoundary>
    {isCaptureOverlay ? <CaptureOverlayApp /> : <DendroCaptureApp />}
  </BootErrorBoundary>,
);
