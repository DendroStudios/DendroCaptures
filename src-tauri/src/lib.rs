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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaCaptureSession {
    width: u32,
    height: u32,
    scale_factor: f64,
    origin_x: i32,
    origin_y: i32,
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
) -> Result<AreaCaptureSession, String> {
    let screen = screen_for_point(cursor_x, cursor_y)?;
    let info = screen.display_info;
    Ok(AreaCaptureSession {
        width: info.width,
        height: info.height,
        scale_factor: f64::from(info.scale_factor),
        origin_x: info.x,
        origin_y: info.y,
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

/// Makes the capture overlay non-occluding for Chromium-based apps so a
/// browser underneath keeps rendering video instead of freezing as "hidden".
/// Chromium's native window occlusion tracker skips a window when it is a
/// layered window with alpha below 255 OR when it has a complex (non
/// rectangular) window region; both are applied here because either can be
/// reset by the windowing stack. Visually the overlay stays indistinguishable
/// from opaque: alpha is 254/255 and the region only drops one corner pixel.
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
            WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
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
                (ex_style | WS_EX_LAYERED as isize | WS_EX_TOOLWINDOW as isize)
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
            prepare_overlay_window,
            copy_png_to_clipboard,
            platform_label,
            active_window_context,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DendroCapture");
}
