use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use image::{imageops, DynamicImage, ImageOutputFormat, RgbaImage};
use keyring::Entry;
use rand_core::OsRng;
use screenshots::Screen;
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, fs, io::Cursor, path::{Path, PathBuf}};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

const KEYRING_SERVICE: &str = "DendroCapture";
const KEYRING_DEVICE_KEY: &str = "device-ed25519";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    png_base64: String,
    width: u32,
    height: u32,
    display_width: u32,
    display_height: u32,
    scale_factor: f64,
    origin_x: i32,
    origin_y: i32,
    monitors: Vec<CaptureMonitor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMonitor {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    is_primary: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AreaCaptureSession {
    width: u32,
    height: u32,
    scale_factor: f64,
    origin_x: i32,
    origin_y: i32,
    png_base64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCaptureRecord {
    metadata_json: String,
    file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPreview {
    monitor: CaptureMonitor,
    png_base64: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePublicKey {
    public_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCaptureSave {
    file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowContext {
    app_name: Option<String>,
    window_title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegionRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy)]
struct VirtualDesktopBounds {
    origin_x: i32,
    origin_y: i32,
}

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn device_key_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_DEVICE_KEY).map_err(err)
}

fn load_or_create_signing_key() -> Result<SigningKey, String> {
    let entry = device_key_entry()?;
    if let Ok(encoded) = entry.get_password() {
        let bytes = BASE64.decode(encoded).map_err(err)?;
        let key_bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "Stored DendroCapture key has an invalid length".to_string())?;
        return Ok(SigningKey::from_bytes(&key_bytes));
    }

    let mut rng = OsRng;
    let signing_key = SigningKey::generate(&mut rng);
    entry
        .set_password(&BASE64.encode(signing_key.to_bytes()))
        .map_err(err)?;
    Ok(signing_key)
}

fn encode_png(mut image: RgbaImage, quality_scale: f64) -> Result<(Vec<u8>, u32, u32), String> {
    let scale = quality_scale.clamp(0.25, 1.0);
    if scale < 0.999 {
        let next_width = ((image.width() as f64) * scale).round().max(1.0) as u32;
        let next_height = ((image.height() as f64) * scale).round().max(1.0) as u32;
        image = imageops::resize(&image, next_width, next_height, imageops::FilterType::CatmullRom);
    }
    let (width, height) = (image.width(), image.height());
    // Screen captures are opaque; dropping the alpha channel makes the PNG
    // roughly a quarter smaller and faster to encode.
    let rgb = DynamicImage::ImageRgba8(image).into_rgb8();
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(rgb)
        .write_to(&mut out, ImageOutputFormat::Png)
        .map_err(err)?;
    Ok((out.into_inner(), width, height))
}

fn first_screen() -> Result<Screen, String> {
    Screen::all()
        .map_err(err)?
        .into_iter()
        .next()
        .ok_or_else(|| "No display was found".to_string())
}

fn screen_for_point(x: Option<i32>, y: Option<i32>) -> Result<Screen, String> {
    match (x, y) {
        (Some(px), Some(py)) => match Screen::from_point(px, py) {
            Ok(screen) => Ok(screen),
            Err(_) => first_screen(),
        },
        _ => first_screen(),
    }
}

fn virtual_desktop_bounds(screens: &[Screen]) -> Result<VirtualDesktopBounds, String> {
    let first = screens
        .first()
        .ok_or_else(|| "No display was found".to_string())?
        .display_info;
    let mut min_x = first.x;
    let mut min_y = first.y;

    for screen in screens.iter().skip(1) {
        let info = screen.display_info;
        min_x = min_x.min(info.x);
        min_y = min_y.min(info.y);
    }

    Ok(VirtualDesktopBounds {
        origin_x: min_x,
        origin_y: min_y,
    })
}

fn capture_monitors(screens: &[Screen], bounds: VirtualDesktopBounds) -> Vec<CaptureMonitor> {
    screens
        .iter()
        .map(|screen| {
            let info = screen.display_info;
            CaptureMonitor {
                id: info.id,
                x: info.x - bounds.origin_x,
                y: info.y - bounds.origin_y,
                width: info.width,
                height: info.height,
                scale_factor: f64::from(info.scale_factor),
                is_primary: info.is_primary,
            }
        })
        .collect()
}

fn screens_layout() -> Result<(Vec<Screen>, VirtualDesktopBounds, Vec<CaptureMonitor>), String> {
    let screens = Screen::all().map_err(err)?;
    let bounds = virtual_desktop_bounds(&screens)?;
    let monitors = capture_monitors(&screens, bounds);
    Ok((screens, bounds, monitors))
}

fn empty_capture_monitors() -> Vec<CaptureMonitor> {
    Vec::new()
}

fn pending_capture_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid pending capture id".to_string());
    }

    if id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(id)
    } else {
        Err("Invalid pending capture id".to_string())
    }
}

fn pending_capture_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let id = pending_capture_id(id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("pending-captures");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(format!("{id}.png")))
}

fn safe_local_capture_filename(filename: &str) -> String {
    let mut clean = filename
        .replace('\0', "")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect::<String>();
    if !clean.to_ascii_lowercase().ends_with(".png") {
        clean.push_str(".png");
    }
    if clean.len() > 120 {
        clean = format!("{}.png", &clean[..116]);
    }
    if clean == ".png" {
        "dendro-capture.png".to_string()
    } else {
        clean
    }
}

fn local_capture_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let safe_filename = safe_local_capture_filename(filename);
    let month = safe_filename
        .split('-')
        .nth(2)
        .and_then(|date| date.get(0..6))
        .map(|date| format!("{}-{}", &date[0..4], &date[4..6]))
        .unwrap_or_else(|| "captures".to_string());
    let dir = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("local-captures")
        .join(month);
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(safe_filename))
}

fn local_captures_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("local-captures");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn validated_local_capture_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = local_captures_root(app)?.canonicalize().map_err(err)?;
    let candidate = PathBuf::from(path);
    let candidate = candidate.canonicalize().map_err(err)?;
    if !candidate.starts_with(&root) {
        return Err("Capture file is outside the DendroCapture local history".to_string());
    }
    Ok(candidate)
}

#[tauri::command]
async fn save_pending_capture(app: AppHandle, id: String, png_base64: String) -> Result<(), String> {
    let bytes = BASE64.decode(png_base64).map_err(err)?;
    let path = pending_capture_path(&app, &id)?;
    fs::write(path, bytes).map_err(err)
}

#[tauri::command]
async fn read_pending_capture(app: AppHandle, id: String) -> Result<String, String> {
    let path = pending_capture_path(&app, &id)?;
    let bytes = fs::read(path).map_err(err)?;
    Ok(BASE64.encode(bytes))
}

#[tauri::command]
async fn read_local_capture(app: AppHandle, path: String) -> Result<String, String> {
    let path = validated_local_capture_path(&app, &path)?;
    let bytes = fs::read(path).map_err(err)?;
    image::load_from_memory(&bytes).map_err(err)?;
    Ok(BASE64.encode(bytes))
}

#[tauri::command]
fn delete_pending_capture(app: AppHandle, id: String) -> Result<(), String> {
    let path = pending_capture_path(&app, &id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn save_local_capture(
    app: AppHandle,
    filename: String,
    png_base64: String,
    metadata_json: String,
) -> Result<LocalCaptureSave, String> {
    let bytes = BASE64.decode(png_base64).map_err(err)?;
    image::load_from_memory(&bytes).map_err(err)?;
    let path = local_capture_path(&app, &filename)?;
    fs::write(&path, bytes).map_err(err)?;
    if !metadata_json.trim().is_empty() {
        let metadata_path = path.with_extension("json");
        fs::write(metadata_path, metadata_json).map_err(err)?;
    }
    Ok(LocalCaptureSave {
        file_path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn overwrite_local_capture(
    app: AppHandle,
    path: String,
    png_base64: String,
    metadata_json: String,
) -> Result<LocalCaptureSave, String> {
    let path = validated_local_capture_path(&app, &path)?;
    let bytes = BASE64.decode(png_base64).map_err(err)?;
    image::load_from_memory(&bytes).map_err(err)?;
    fs::write(&path, bytes).map_err(err)?;
    if !metadata_json.trim().is_empty() {
        let metadata_path = path.with_extension("json");
        fs::write(metadata_path, metadata_json).map_err(err)?;
    }
    Ok(LocalCaptureSave {
        file_path: path.to_string_lossy().to_string(),
    })
}

fn launched_hidden_flag() -> bool {
    std::env::args().any(|arg| arg == "--hidden")
}

#[tauri::command]
fn launched_hidden() -> bool {
    launched_hidden_flag()
}

#[tauri::command]
async fn reveal_in_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("File no longer exists".to_string());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(err)
}

#[tauri::command]
async fn reveal_pending_capture(app: AppHandle, id: String) -> Result<(), String> {
    let path = pending_capture_path(&app, &id)?;
    if !path.exists() {
        return Err("Capture file no longer exists".to_string());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(err)
}

// Async: keyring access talks to the OS credential store and must never be
// able to stall the main thread (a blocked main thread makes the tray and
// window controls unresponsive - the app looks alive but nothing reacts).
#[tauri::command]
async fn ensure_device_keypair() -> Result<DevicePublicKey, String> {
    let signing_key = load_or_create_signing_key()?;
    Ok(DevicePublicKey {
        public_key: BASE64.encode(signing_key.verifying_key().to_bytes()),
    })
}

#[tauri::command]
async fn sign_challenge(challenge_id: String, challenge: String) -> Result<String, String> {
    let signing_key = load_or_create_signing_key()?;
    let message = format!("dendro-capture:{challenge_id}:{challenge}");
    Ok(BASE64.encode(signing_key.sign(message.as_bytes()).to_bytes()))
}

#[tauri::command]
async fn capture_monitor_previews(max_width: u32) -> Result<Vec<MonitorPreview>, String> {
    let (screens, bounds, _) = screens_layout()?;
    let max_width = max_width.clamp(80, 420);
    let mut previews = Vec::with_capacity(screens.len());

    for screen in screens {
        let info = screen.display_info;
        let image = screen.capture().map_err(err)?;
        let scale = max_width as f64 / image.width().max(1) as f64;
        let width = max_width;
        let height = ((image.height() as f64) * scale).round().max(1.0) as u32;
        let thumb = imageops::resize(&image, width, height, imageops::FilterType::Triangle);
        let (png, _, _) = encode_png(thumb, 1.0)?;
        previews.push(MonitorPreview {
            monitor: CaptureMonitor {
                id: info.id,
                x: info.x - bounds.origin_x,
                y: info.y - bounds.origin_y,
                width: info.width,
                height: info.height,
                scale_factor: f64::from(info.scale_factor),
                is_primary: info.is_primary,
            },
            png_base64: BASE64.encode(png),
            width,
            height,
        });
    }

    Ok(previews)
}

#[tauri::command]
async fn capture_display(monitor_id: u32, quality_scale: f64) -> Result<CaptureResult, String> {
    let screen = Screen::all()
        .map_err(err)?
        .into_iter()
        .find(|screen| screen.display_info.id == monitor_id)
        .ok_or_else(|| "Selected display was not found".to_string())?;
    let info = screen.display_info;
    let image = screen.capture().map_err(err)?;
    let display_width = image.width();
    let display_height = image.height();
    let (png, width, height) = encode_png(image, quality_scale)?;
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width,
        height,
        display_width,
        display_height,
        scale_factor: f64::from(info.scale_factor),
        origin_x: info.x,
        origin_y: info.y,
        monitors: empty_capture_monitors(),
    })
}

#[tauri::command]
async fn begin_area_capture(
    cursor_x: Option<i32>,
    cursor_y: Option<i32>,
    include_snapshot: Option<bool>,
) -> Result<AreaCaptureSession, String> {
    let screen = screen_for_point(cursor_x, cursor_y)?;
    let info = screen.display_info;
    let (width, height, png_base64) = if include_snapshot.unwrap_or(true) {
        let image = screen.capture().map_err(err)?;
        let (png, width, height) = encode_png(image, 1.0)?;
        (width, height, Some(BASE64.encode(png)))
    } else {
        (info.width, info.height, None)
    };
    Ok(AreaCaptureSession {
        width,
        height,
        scale_factor: f64::from(info.scale_factor),
        origin_x: info.x,
        origin_y: info.y,
        png_base64,
    })
}

#[tauri::command]
async fn finish_area_capture(rect: CaptureRegionRect, quality_scale: f64) -> Result<CaptureResult, String> {
    let screen = screen_for_point(Some(rect.x), Some(rect.y))?;
    let info = screen.display_info;
    let image = screen.capture().map_err(err)?;
    let scale_x = image.width() as f64 / f64::from(info.width.max(1));
    let scale_y = image.height() as f64 / f64::from(info.height.max(1));
    let x = (((rect.x - info.x) as f64) * scale_x)
        .round()
        .clamp(0.0, image.width().saturating_sub(1) as f64) as u32;
    let y = (((rect.y - info.y) as f64) * scale_y)
        .round()
        .clamp(0.0, image.height().saturating_sub(1) as f64) as u32;
    let width = ((f64::from(rect.width.max(1)) * scale_x).round().max(1.0) as u32)
        .min(image.width() - x)
        .max(1);
    let height = ((f64::from(rect.height.max(1)) * scale_y).round().max(1.0) as u32)
        .min(image.height() - y)
        .max(1);
    let display_width = width;
    let display_height = height;
    let cropped = imageops::crop_imm(&image, x, y, width, height).to_image();
    let (png, out_width, out_height) = encode_png(cropped, quality_scale)?;
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: out_width,
        height: out_height,
        display_width,
        display_height,
        scale_factor: f64::from(info.scale_factor),
        origin_x: rect.x,
        origin_y: rect.y,
        monitors: empty_capture_monitors(),
    })
}

#[tauri::command]
async fn finish_area_capture_from_snapshot(
    session: AreaCaptureSession,
    rect: CaptureRegionRect,
    quality_scale: f64,
) -> Result<CaptureResult, String> {
    let png_base64 = session
        .png_base64
        .ok_or_else(|| "Area capture snapshot is missing".to_string())?;
    let bytes = BASE64.decode(png_base64).map_err(err)?;
    let image = image::load_from_memory(&bytes).map_err(err)?.to_rgba8();
    let scale_x = image.width() as f64 / f64::from(session.width.max(1));
    let scale_y = image.height() as f64 / f64::from(session.height.max(1));
    let x = (((rect.x - session.origin_x) as f64) * scale_x)
        .round()
        .clamp(0.0, image.width().saturating_sub(1) as f64) as u32;
    let y = (((rect.y - session.origin_y) as f64) * scale_y)
        .round()
        .clamp(0.0, image.height().saturating_sub(1) as f64) as u32;
    let width = ((f64::from(rect.width.max(1)) * scale_x).round().max(1.0) as u32)
        .min(image.width() - x)
        .max(1);
    let height = ((f64::from(rect.height.max(1)) * scale_y).round().max(1.0) as u32)
        .min(image.height() - y)
        .max(1);
    let cropped = imageops::crop_imm(&image, x, y, width, height).to_image();
    let (png, out_width, out_height) = encode_png(cropped, quality_scale)?;
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: out_width,
        height: out_height,
        display_width: width,
        display_height: height,
        scale_factor: session.scale_factor,
        origin_x: rect.x,
        origin_y: rect.y,
        monitors: empty_capture_monitors(),
    })
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct NativeSelectionState {
    start_x: i32,
    start_y: i32,
    current_x: i32,
    current_y: i32,
    drawn_left: i32,
    drawn_top: i32,
    drawn_right: i32,
    drawn_bottom: i32,
    has_drawn: bool,
    dragging: bool,
    done: bool,
    cancelled: bool,
}

#[cfg(target_os = "windows")]
struct NativeSelectionHookContext {
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
    state: *mut NativeSelectionState,
}

#[cfg(target_os = "windows")]
static mut NATIVE_SELECTION_HOOK_CONTEXT: *mut NativeSelectionHookContext = std::ptr::null_mut();

#[cfg(target_os = "windows")]
fn native_select_region_alpha_window(cursor_x: Option<i32>, cursor_y: Option<i32>) -> Result<CaptureRegionRect, String> {
    use std::{ffi::c_void, mem::zeroed, ptr::null_mut};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{CreateSolidBrush, UpdateWindow};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, ReleaseCapture, SetCapture, VK_ESCAPE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetWindowLongPtrW,
        LoadCursorW, PeekMessageW, RegisterClassW, SetCursor,
        SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage,
        CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, HWND_TOPMOST,
        IDC_CROSS, LWA_ALPHA, MSG, PM_REMOVE, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, WM_CREATE, WM_DESTROY, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
        WM_RBUTTONDOWN, WM_SETCURSOR, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    const INPUT_CLASS: &[u16] = &[
        b'D' as u16, b'e' as u16, b'n' as u16, b'd' as u16, b'r' as u16, b'o' as u16,
        b'C' as u16, b'a' as u16, b'p' as u16, b't' as u16, b'u' as u16, b'r' as u16,
        b'e' as u16, b'I' as u16, b'n' as u16, b'p' as u16, b'u' as u16, b't' as u16,
        0,
    ];
    const BORDER_CLASS: &[u16] = &[
        b'D' as u16, b'e' as u16, b'n' as u16, b'd' as u16, b'r' as u16, b'o' as u16,
        b'C' as u16, b'a' as u16, b'p' as u16, b't' as u16, b'u' as u16, b'r' as u16,
        b'e' as u16, b'B' as u16, b'o' as u16, b'r' as u16, b'd' as u16, b'e' as u16,
        b'r' as u16, 0,
    ];
    const BORDER_COLOR: u32 = 0x00ffbd84;
    const BORDER_THICKNESS: i32 = 2;

    #[derive(Default)]
    struct AlphaSelectionState {
        origin_x: i32,
        origin_y: i32,
        capture_width: u32,
        capture_height: u32,
        client_width: i32,
        client_height: i32,
        start_x: i32,
        start_y: i32,
        current_x: i32,
        current_y: i32,
        dragging: bool,
        done: bool,
        cancelled: bool,
        borders: [HWND; 4],
    }

    fn point_from_lparam(lparam: LPARAM) -> (i32, i32) {
        let x = (lparam as u32 & 0xffff) as i16 as i32;
        let y = ((lparam as u32 >> 16) & 0xffff) as i16 as i32;
        (x, y)
    }

    unsafe fn hide_borders(state: &AlphaSelectionState) {
        for hwnd in state.borders {
            if !hwnd.is_null() {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }

    unsafe fn update_borders(state: &AlphaSelectionState) {
        let left = state.start_x.min(state.current_x) + state.origin_x;
        let top = state.start_y.min(state.current_y) + state.origin_y;
        let right = state.start_x.max(state.current_x) + state.origin_x;
        let bottom = state.start_y.max(state.current_y) + state.origin_y;
        let width = (right - left).max(1);
        let height = (bottom - top).max(1);
        let t = BORDER_THICKNESS;
        let rects = [
            (left, top, width, t),
            (left, bottom.saturating_sub(t), width, t),
            (left, top, t, height),
            (right.saturating_sub(t), top, t, height),
        ];

        for (hwnd, (x, y, w, h)) in state.borders.into_iter().zip(rects) {
            if hwnd.is_null() {
                continue;
            }
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                x,
                y,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    fn selected_capture_rect(state: &AlphaSelectionState) -> CaptureRegionRect {
        let client_width = state.client_width.max(1);
        let client_height = state.client_height.max(1);
        let left = state.start_x.min(state.current_x).clamp(0, client_width);
        let top = state.start_y.min(state.current_y).clamp(0, client_height);
        let right = state.start_x.max(state.current_x).clamp(0, client_width);
        let bottom = state.start_y.max(state.current_y).clamp(0, client_height);
        let scale_x = state.capture_width as f64 / f64::from(client_width);
        let scale_y = state.capture_height as f64 / f64::from(client_height);
        let x = state.origin_x + (f64::from(left) * scale_x).round() as i32;
        let y = state.origin_y + (f64::from(top) * scale_y).round() as i32;
        let width = (f64::from((right - left).max(1)) * scale_x).round().max(1.0) as u32;
        let height = (f64::from((bottom - top).max(1)) * scale_y).round().max(1.0) as u32;
        let max_width = state.capture_width.saturating_sub((x - state.origin_x).max(0) as u32).max(1);
        let max_height = state.capture_height.saturating_sub((y - state.origin_y).max(0) as u32).max(1);
        CaptureRegionRect {
            x,
            y,
            width: width.min(max_width),
            height: height.min(max_height),
        }
    }

    unsafe extern "system" fn input_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AlphaSelectionState;
        match msg {
            WM_CREATE => {
                let create = lparam as *const CREATESTRUCTW;
                if !create.is_null() {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*create).lpCreateParams as isize);
                }
                0
            }
            WM_SETCURSOR => {
                SetCursor(LoadCursorW(null_mut(), IDC_CROSS));
                1
            }
            WM_LBUTTONDOWN => {
                if !state_ptr.is_null() {
                    let (x, y) = point_from_lparam(lparam);
                    let state = &mut *state_ptr;
                    state.start_x = x;
                    state.start_y = y;
                    state.current_x = x;
                    state.current_y = y;
                    state.dragging = true;
                    SetCapture(hwnd);
                    update_borders(state);
                }
                0
            }
            WM_MOUSEMOVE => {
                if !state_ptr.is_null() {
                    let (x, y) = point_from_lparam(lparam);
                    let state = &mut *state_ptr;
                    state.current_x = x;
                    state.current_y = y;
                    if state.dragging {
                        update_borders(state);
                    }
                }
                0
            }
            WM_LBUTTONUP => {
                if !state_ptr.is_null() {
                    let (x, y) = point_from_lparam(lparam);
                    let state = &mut *state_ptr;
                    state.current_x = x;
                    state.current_y = y;
                    state.dragging = false;
                    ReleaseCapture();
                    hide_borders(state);
                    let width = (state.current_x - state.start_x).abs();
                    let height = (state.current_y - state.start_y).abs();
                    if width < 8 || height < 8 {
                        state.cancelled = true;
                    } else {
                        state.done = true;
                    }
                }
                0
            }
            WM_RBUTTONDOWN => {
                if !state_ptr.is_null() {
                    let state = &mut *state_ptr;
                    state.cancelled = true;
                    ReleaseCapture();
                    hide_borders(state);
                }
                0
            }
            WM_DESTROY => 0,
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe extern "system" fn border_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    let screen = screen_for_point(cursor_x, cursor_y)?;
    let info = screen.display_info;
    let mut state = Box::new(AlphaSelectionState {
        origin_x: info.x,
        origin_y: info.y,
        capture_width: info.width,
        capture_height: info.height,
        client_width: info.width as i32,
        client_height: info.height as i32,
        ..Default::default()
    });

    unsafe {
        let input_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(input_wnd_proc),
            hInstance: null_mut(),
            lpszClassName: INPUT_CLASS.as_ptr(),
            hCursor: LoadCursorW(null_mut(), IDC_CROSS),
            ..zeroed()
        };
        RegisterClassW(&input_class);

        let border_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(border_wnd_proc),
            hInstance: null_mut(),
            lpszClassName: BORDER_CLASS.as_ptr(),
            hbrBackground: CreateSolidBrush(BORDER_COLOR),
            ..zeroed()
        };
        RegisterClassW(&border_class);

        for index in 0..state.borders.len() {
            state.borders[index] = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                BORDER_CLASS.as_ptr(),
                BORDER_CLASS.as_ptr(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            );
        }

        let input_hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE,
            INPUT_CLASS.as_ptr(),
            INPUT_CLASS.as_ptr(),
            WS_POPUP,
            info.x,
            info.y,
            info.width as i32,
            info.height as i32,
            null_mut(),
            null_mut(),
            null_mut(),
            state.as_mut() as *mut AlphaSelectionState as *const c_void,
        );
        if input_hwnd.is_null() {
            for border in state.borders {
                if !border.is_null() {
                    DestroyWindow(border);
                }
            }
            return Err("Could not open native capture selector".to_string());
        }

        SetLayeredWindowAttributes(input_hwnd, 0, 1, LWA_ALPHA);
        ShowWindow(input_hwnd, SW_SHOWNOACTIVATE);
        UpdateWindow(input_hwnd);
        let mut client_rect: RECT = zeroed();
        if GetClientRect(input_hwnd, &mut client_rect) != 0 {
            state.client_width = (client_rect.right - client_rect.left).max(1);
            state.client_height = (client_rect.bottom - client_rect.top).max(1);
        }

        let mut msg: MSG = zeroed();
        while !state.done && !state.cancelled {
            while PeekMessageW(&mut msg, null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if GetAsyncKeyState(VK_ESCAPE.into()) < 0 {
                state.cancelled = true;
                hide_borders(&state);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        }

        DestroyWindow(input_hwnd);
        for border in state.borders {
            if !border.is_null() {
                DestroyWindow(border);
            }
        }
    }

    if state.cancelled {
        return Err("Area capture canceled".to_string());
    }

    Ok(selected_capture_rect(&state))
}

#[cfg(target_os = "windows")]
fn native_select_region(cursor_x: Option<i32>, cursor_y: Option<i32>) -> Result<CaptureRegionRect, String> {
    use std::{mem::zeroed, ptr::null_mut, time::Duration};
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CreatePen, DeleteObject, GetDC, GetStockObject, Rectangle, ReleaseDC, SelectObject,
        SetROP2, HOLLOW_BRUSH, PS_SOLID, R2_NOTXORPEN,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_ESCAPE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetCursorPos, HHOOK, MSLLHOOKSTRUCT, PeekMessageW,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, MSG, PM_REMOVE, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN,
    };
    const XOR_LINE_COLOR: u32 = 0x00ffffff;

    unsafe fn draw_focus_rect(state: &mut NativeSelectionState, left: i32, top: i32, right: i32, bottom: i32) {
        if right <= left || bottom <= top {
            return;
        }
        let hdc = GetDC(null_mut());
        if hdc.is_null() {
            return;
        }
        let old_rop = SetROP2(hdc, R2_NOTXORPEN);
        let pen = CreatePen(PS_SOLID, 2, XOR_LINE_COLOR);
        let old_pen = SelectObject(hdc, pen as _);
        let old_brush = SelectObject(hdc, GetStockObject(HOLLOW_BRUSH));
        Rectangle(hdc, left, top, right, bottom);
        SelectObject(hdc, old_brush);
        SelectObject(hdc, old_pen);
        DeleteObject(pen as _);
        SetROP2(hdc, old_rop);
        ReleaseDC(null_mut(), hdc);
        state.drawn_left = left;
        state.drawn_top = top;
        state.drawn_right = right;
        state.drawn_bottom = bottom;
        state.has_drawn = true;
    }

    unsafe fn erase_focus_rect(state: &mut NativeSelectionState) {
        if !state.has_drawn {
            return;
        }
        let hdc = GetDC(null_mut());
        if hdc.is_null() {
            return;
        }
        let old_rop = SetROP2(hdc, R2_NOTXORPEN);
        let pen = CreatePen(PS_SOLID, 2, XOR_LINE_COLOR);
        let old_pen = SelectObject(hdc, pen as _);
        let old_brush = SelectObject(hdc, GetStockObject(HOLLOW_BRUSH));
        Rectangle(hdc, state.drawn_left, state.drawn_top, state.drawn_right, state.drawn_bottom);
        SelectObject(hdc, old_brush);
        SelectObject(hdc, old_pen);
        DeleteObject(pen as _);
        SetROP2(hdc, old_rop);
        ReleaseDC(null_mut(), hdc);
        state.has_drawn = false;
    }

    unsafe fn redraw_selection(state: &mut NativeSelectionState, context: &NativeSelectionHookContext) {
        erase_focus_rect(state);
        if !state.dragging {
            return;
        }
        let left = state.start_x.min(state.current_x) + context.origin_x;
        let top = state.start_y.min(state.current_y) + context.origin_y;
        let right = state.start_x.max(state.current_x) + context.origin_x;
        let bottom = state.start_y.max(state.current_y) + context.origin_y;
        draw_focus_rect(state, left, top, right, bottom);
    }

    unsafe fn update_cursor_selection(state: &mut NativeSelectionState, context: &NativeSelectionHookContext) {
        if !state.dragging {
            return;
        }
        let mut point: POINT = zeroed();
        if GetCursorPos(&mut point) == 0 {
            return;
        }
        let x = (point.x - context.origin_x).clamp(0, context.width.max(1));
        let y = (point.y - context.origin_y).clamp(0, context.height.max(1));
        if x == state.current_x && y == state.current_y {
            return;
        }
        state.current_x = x;
        state.current_y = y;
        redraw_selection(state, context);
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code < 0 {
            return CallNextHookEx(null_mut(), code, wparam, lparam);
        }

        let context = NATIVE_SELECTION_HOOK_CONTEXT;
        if context.is_null() {
            return CallNextHookEx(null_mut(), code, wparam, lparam);
        }
        let context = &mut *context;
        let state = &mut *context.state;
        let mouse = &*(lparam as *const MSLLHOOKSTRUCT);
        let x = (mouse.pt.x - context.origin_x).clamp(0, context.width.max(1));
        let y = (mouse.pt.y - context.origin_y).clamp(0, context.height.max(1));

        match wparam as u32 {
            WM_LBUTTONDOWN => {
                state.start_x = x;
                state.start_y = y;
                state.current_x = x;
                state.current_y = y;
                state.dragging = true;
                1
            }
            WM_LBUTTONUP => {
                state.current_x = x;
                state.current_y = y;
                state.dragging = false;
                let width = (state.current_x - state.start_x).abs();
                let height = (state.current_y - state.start_y).abs();
                if width < 8 || height < 8 {
                    state.cancelled = true;
                } else {
                    state.done = true;
                }
                erase_focus_rect(state);
                1
            }
            WM_RBUTTONDOWN => {
                erase_focus_rect(state);
                state.cancelled = true;
                1
            }
            _ => CallNextHookEx(null_mut(), code, wparam, lparam),
        }
    }

    let screen = screen_for_point(cursor_x, cursor_y)?;
    let info = screen.display_info;
    let mut state = Box::new(NativeSelectionState::default());
    let state_ptr = state.as_mut() as *mut NativeSelectionState;

    unsafe {
        let mut hook_context = NativeSelectionHookContext {
            origin_x: info.x,
            origin_y: info.y,
            width: info.width as i32,
            height: info.height as i32,
            state: state_ptr,
        };
        NATIVE_SELECTION_HOOK_CONTEXT = &mut hook_context;
        let module = GetModuleHandleW(null_mut());
        let hook: HHOOK = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0);
        if hook.is_null() {
            NATIVE_SELECTION_HOOK_CONTEXT = null_mut();
            return Err("Could not install native capture mouse hook".to_string());
        }

        let mut msg: MSG = zeroed();
        while !state.done && !state.cancelled {
            while PeekMessageW(&mut msg, null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            update_cursor_selection(&mut state, &hook_context);
            if GetAsyncKeyState(VK_ESCAPE.into()) < 0 {
                state.cancelled = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(4));
        }

        erase_focus_rect(&mut state);
        UnhookWindowsHookEx(hook);
        NATIVE_SELECTION_HOOK_CONTEXT = null_mut();
    }

    if state.cancelled {
        return Err("Area capture canceled".to_string());
    }

    let left = state.start_x.min(state.current_x) + info.x;
    let top = state.start_y.min(state.current_y) + info.y;
    Ok(CaptureRegionRect {
        x: left,
        y: top,
        width: (state.current_x - state.start_x).unsigned_abs(),
        height: (state.current_y - state.start_y).unsigned_abs(),
    })
}

#[cfg(not(target_os = "windows"))]
fn native_select_region(_cursor_x: Option<i32>, _cursor_y: Option<i32>) -> Result<CaptureRegionRect, String> {
    Err("Native live area selection is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
fn snipping_tool_area_capture(quality_scale: f64) -> Result<CaptureResult, String> {
    use std::{process::Command, thread, time::{Duration, Instant}};
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let before = unsafe { GetClipboardSequenceNumber() };
    let status = Command::new("snippingtool")
        .arg("/clip")
        .status()
        .map_err(|error| format!("Could not start Windows Snipping Tool: {error}"))?;

    if !status.success() {
        return Err("Area capture canceled".to_string());
    }

    let started = Instant::now();
    let mut clipboard = Clipboard::new().map_err(err)?;
    loop {
        let changed = unsafe { GetClipboardSequenceNumber() } != before;
        if changed {
            if let Ok(image) = clipboard.get_image() {
                let width = image.width as u32;
                let height = image.height as u32;
                let rgba = RgbaImage::from_raw(width, height, image.bytes.into_owned())
                    .ok_or_else(|| "Snipping Tool returned an invalid image".to_string())?;
                let (png, out_width, out_height) = encode_png(rgba, quality_scale)?;
                return Ok(CaptureResult {
                    png_base64: BASE64.encode(png),
                    width: out_width,
                    height: out_height,
                    display_width: width,
                    display_height: height,
                    scale_factor: 1.0,
                    origin_x: 0,
                    origin_y: 0,
                    monitors: empty_capture_monitors(),
                });
            }
        }

        if started.elapsed() > Duration::from_secs(5) {
            return Err("Snipping Tool did not place an image on the clipboard".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(not(target_os = "windows"))]
fn snipping_tool_area_capture(_quality_scale: f64) -> Result<CaptureResult, String> {
    Err("Windows Snipping Tool capture is only available on Windows".to_string())
}

#[tauri::command]
async fn native_area_capture(
    cursor_x: Option<i32>,
    cursor_y: Option<i32>,
    quality_scale: f64,
) -> Result<CaptureResult, String> {
    match native_select_region_alpha_window(cursor_x, cursor_y) {
        Ok(rect) => finish_area_capture(rect, quality_scale).await,
        Err(error) if error == "Area capture canceled" => Err(error),
        Err(_) => match native_select_region(cursor_x, cursor_y) {
            Ok(rect) => finish_area_capture(rect, quality_scale).await,
            Err(error) if error == "Area capture canceled" => Err(error),
            Err(_) => snipping_tool_area_capture(quality_scale),
        }
    }
}

/// Keeps the capture overlay predictable across Windows compositors. The
/// layered style and tiny complex region avoid several Chromium/window-manager
/// occlusion edge cases, and are harmless now that normal area capture crops a
/// frame grabbed before the overlay was shown.
#[tauri::command]
fn prepare_overlay_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("capture-overlay")
        .ok_or_else(|| "Capture overlay window was not found".to_string())?;

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos,
            GWL_EXSTYLE, GWL_STYLE, LWA_ALPHA, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_LAYERED,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
        };

        let hwnd = window.hwnd().map_err(err)?.0 as windows_sys::Win32::Foundation::HWND;
        let size = window.outer_size().map_err(err)?;
        let width = size.width.max(2) as i32;
        let height = size.height.max(2) as i32;

        unsafe {
            // Tauri asks for a borderless overlay, but Windows can briefly
            // surface native chrome while a no-activate overlay is dragged.
            // Clear it explicitly before every capture session.
            let chrome_bits = (WS_CAPTION
                | WS_THICKFRAME
                | WS_SYSMENU
                | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX) as isize;
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !chrome_bits);

            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                (ex_style | WS_EX_LAYERED as isize | WS_EX_TOOLWINDOW as isize | WS_EX_NOACTIVATE as isize)
                    & !(WS_EX_APPWINDOW as isize),
            );
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            // Best effort: the window region below is the reliable exclusion.
            SetLayeredWindowAttributes(hwnd, 0, 254, LWA_ALPHA);

            // Full window minus a 1x1 notch at the bottom-right corner; two
            // rectangles make GetWindowRgn report COMPLEXREGION.
            let main_region = CreateRectRgn(0, 0, width, height - 1);
            let bottom_region = CreateRectRgn(0, height - 1, width - 1, height);
            let combined = CreateRectRgn(0, 0, 0, 0);
            CombineRgn(combined, main_region, bottom_region, RGN_OR);
            DeleteObject(main_region as _);
            DeleteObject(bottom_region as _);
            // On success the system owns the region handle.
            if SetWindowRgn(hwnd, combined, 1) == 0 {
                DeleteObject(combined as _);
                return Err("Could not configure the capture overlay window".to_string());
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }

    Ok(())
}

#[tauri::command]
async fn list_local_captures(app: AppHandle, limit: usize) -> Result<Vec<LocalCaptureRecord>, String> {
    let root = local_captures_root(&app)?;
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();

    for month in fs::read_dir(&root).map_err(err)? {
        let month = month.map_err(err)?.path();
        if !month.is_dir() {
            continue;
        }
        for file in fs::read_dir(&month).map_err(err)? {
            let file = file.map_err(err)?;
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let modified = file
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            entries.push((modified, path));
        }
    }

    entries.sort_by(|a, b| b.0.cmp(&a.0));
    let mut records = Vec::new();
    for (_, json_path) in entries.into_iter().take(limit.clamp(1, 200)) {
        let png_path = json_path.with_extension("png");
        if !png_path.exists() {
            continue;
        }
        let Ok(metadata_json) = fs::read_to_string(&json_path) else {
            continue;
        };
        records.push(LocalCaptureRecord {
            metadata_json,
            file_path: png_path.to_string_lossy().to_string(),
        });
    }
    Ok(records)
}

#[tauri::command]
async fn copy_png_to_clipboard(png_base64: String) -> Result<(), String> {
    let bytes = BASE64.decode(png_base64).map_err(err)?;
    let image = image::load_from_memory(&bytes).map_err(err)?.to_rgba8();
    let width = image.width() as usize;
    let height = image.height() as usize;
    let mut clipboard = Clipboard::new().map_err(err)?;
    clipboard
        .set_image(ImageData {
            width,
            height,
            bytes: Cow::Owned(image.into_raw()),
        })
        .map_err(err)
}

#[tauri::command]
fn platform_label() -> String {
    std::env::consts::OS.to_string()
}

fn clean_context_text(value: String, max_len: usize) -> Option<String> {
    let text = value.replace('\0', "").trim().chars().take(max_len).collect::<String>();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(target_os = "windows")]
fn platform_active_window_context() -> ActiveWindowContext {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return ActiveWindowContext {
                app_name: None,
                window_title: None,
            };
        }

        let title_len = GetWindowTextLengthW(hwnd);
        let window_title = if title_len > 0 {
            let mut title = vec![0_u16; title_len as usize + 1];
            let copied = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
            if copied > 0 {
                clean_context_text(String::from_utf16_lossy(&title[..copied as usize]), 260)
            } else {
                None
            }
        } else {
            None
        };

        let mut process_id = 0_u32;
        GetWindowThreadProcessId(hwnd, &mut process_id);

        let app_name = if process_id > 0 {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if handle.is_null() {
                None
            } else {
                let mut path = vec![0_u16; 32_768];
                let mut size = path.len() as u32;
                let result = QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut size);
                let _ = CloseHandle(handle);
                if result != 0 && size > 0 {
                    let raw = String::from_utf16_lossy(&path[..size as usize]);
                    let name = Path::new(&raw)
                        .file_stem()
                        .or_else(|| Path::new(&raw).file_name())
                        .and_then(|part| part.to_str())
                        .unwrap_or(&raw)
                        .to_string();
                    clean_context_text(name, 120)
                } else {
                    None
                }
            }
        } else {
            None
        };

        ActiveWindowContext {
            app_name,
            window_title,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn platform_active_window_context() -> ActiveWindowContext {
    ActiveWindowContext {
        app_name: None,
        window_title: None,
    }
}

#[tauri::command]
fn active_window_context() -> ActiveWindowContext {
    platform_active_window_context()
}

fn hide_main_window_for_tray<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_content_protected(false);
        let _ = window.set_skip_taskbar(true);
        let _ = window.hide();
    }
}

fn window_is_on_a_monitor<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let (Ok(position), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return true;
    };
    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let bounds = monitor.size();
        position.x < origin.x + bounds.width as i32
            && position.x + size.width as i32 > origin.x
            && position.y < origin.y + bounds.height as i32
            && position.y + size.height as i32 > origin.y
    })
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_content_protected(false);
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        // A monitor change can leave the window stranded outside every
        // display: it "opens" but nothing appears on screen.
        if !window_is_on_a_monitor(&window) {
            let _ = window.center();
        }
    }
}

fn create_tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "Show DendroCapture")
        .separator()
        .text("quit", "Quit")
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("DendroCapture")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|arg| arg == "--hidden") {
                hide_main_window_for_tray(app);
            } else {
                show_main_window(app);
            }
        }))
        .setup(|app| {
            hide_main_window_for_tray(app.handle());
            create_tray(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            save_pending_capture,
            read_pending_capture,
            read_local_capture,
            delete_pending_capture,
            save_local_capture,
            overwrite_local_capture,
            list_local_captures,
            launched_hidden,
            reveal_in_folder,
            reveal_pending_capture,
            ensure_device_keypair,
            sign_challenge,
            capture_monitor_previews,
            capture_display,
            begin_area_capture,
            finish_area_capture,
            finish_area_capture_from_snapshot,
            native_area_capture,
            prepare_overlay_window,
            copy_png_to_clipboard,
            platform_label,
            active_window_context,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DendroCapture");
}
