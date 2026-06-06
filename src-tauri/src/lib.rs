use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use image::{imageops, DynamicImage, ImageOutputFormat, Rgba, RgbaImage};
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
pub struct CaptureLayout {
    origin_x: i32,
    origin_y: i32,
    width: u32,
    height: u32,
    monitors: Vec<CaptureMonitor>,
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
pub struct CropRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
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
    width: u32,
    height: u32,
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

fn encode_png(mut image: RgbaImage, quality_scale: f64) -> Result<Vec<u8>, String> {
    let scale = quality_scale.clamp(0.25, 1.0);
    if scale < 0.999 {
        let next_width = ((image.width() as f64) * scale).round().max(1.0) as u32;
        let next_height = ((image.height() as f64) * scale).round().max(1.0) as u32;
        image = imageops::resize(&image, next_width, next_height, imageops::FilterType::Lanczos3);
    }
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut out, ImageOutputFormat::Png)
        .map_err(err)?;
    Ok(out.into_inner())
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

fn capture_screen_for_point(
    cursor_x: Option<i32>,
    cursor_y: Option<i32>,
) -> Result<(RgbaImage, Screen), String> {
    let screen = screen_for_point(cursor_x, cursor_y)?;
    let image = screen.capture().map_err(err)?;
    Ok((image, screen))
}

fn virtual_desktop_bounds(screens: &[Screen]) -> Result<VirtualDesktopBounds, String> {
    let first = screens
        .first()
        .ok_or_else(|| "No display was found".to_string())?
        .display_info;
    let mut min_x = first.x;
    let mut min_y = first.y;
    let mut max_x = first.x + first.width as i32;
    let mut max_y = first.y + first.height as i32;

    for screen in screens.iter().skip(1) {
        let info = screen.display_info;
        min_x = min_x.min(info.x);
        min_y = min_y.min(info.y);
        max_x = max_x.max(info.x + info.width as i32);
        max_y = max_y.max(info.y + info.height as i32);
    }

    let width = (max_x - min_x)
        .try_into()
        .map_err(|_| "The desktop capture width is invalid".to_string())?;
    let height = (max_y - min_y)
        .try_into()
        .map_err(|_| "The desktop capture height is invalid".to_string())?;

    Ok(VirtualDesktopBounds {
        origin_x: min_x,
        origin_y: min_y,
        width,
        height,
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

fn capture_virtual_desktop() -> Result<(RgbaImage, VirtualDesktopBounds, Vec<CaptureMonitor>), String> {
    let (screens, bounds, monitors) = screens_layout()?;
    let mut desktop = RgbaImage::from_pixel(bounds.width, bounds.height, Rgba([0, 0, 0, 255]));

    for screen in screens {
        let info = screen.display_info;
        let mut image = screen.capture().map_err(err)?;
        if image.width() != info.width || image.height() != info.height {
            image = imageops::resize(
                &image,
                info.width.max(1),
                info.height.max(1),
                imageops::FilterType::Lanczos3,
            );
        }

        let x = i64::from(info.x - bounds.origin_x);
        let y = i64::from(info.y - bounds.origin_y);
        imageops::overlay(&mut desktop, &image, x, y);
    }

    Ok((desktop, bounds, monitors))
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

#[tauri::command]
fn save_pending_capture(app: AppHandle, id: String, png_base64: String) -> Result<(), String> {
    let bytes = BASE64.decode(png_base64).map_err(err)?;
    let path = pending_capture_path(&app, &id)?;
    fs::write(path, bytes).map_err(err)
}

#[tauri::command]
fn read_pending_capture(app: AppHandle, id: String) -> Result<String, String> {
    let path = pending_capture_path(&app, &id)?;
    let bytes = fs::read(path).map_err(err)?;
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
fn save_local_capture(
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
fn ensure_device_keypair() -> Result<DevicePublicKey, String> {
    let signing_key = load_or_create_signing_key()?;
    Ok(DevicePublicKey {
        public_key: BASE64.encode(signing_key.verifying_key().to_bytes()),
    })
}

#[tauri::command]
fn sign_challenge(challenge_id: String, challenge: String) -> Result<String, String> {
    let signing_key = load_or_create_signing_key()?;
    let message = format!("dendro-capture:{challenge_id}:{challenge}");
    Ok(BASE64.encode(signing_key.sign(message.as_bytes()).to_bytes()))
}

#[tauri::command]
fn capture_fullscreen(
    quality_scale: f64,
    cursor_x: Option<i32>,
    cursor_y: Option<i32>,
) -> Result<CaptureResult, String> {
    let (image, screen) = capture_screen_for_point(cursor_x, cursor_y)?;
    let info = screen.display_info;
    let display_width = image.width();
    let display_height = image.height();
    let png = encode_png(image, quality_scale)?;
    let decoded = image::load_from_memory(&png).map_err(err)?.to_rgba8();
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: decoded.width(),
        height: decoded.height(),
        display_width,
        display_height,
        scale_factor: 1.0,
        origin_x: info.x,
        origin_y: info.y,
        monitors: vec![CaptureMonitor {
            id: info.id,
            x: 0,
            y: 0,
            width: display_width,
            height: display_height,
            scale_factor: f64::from(info.scale_factor),
            is_primary: info.is_primary,
        }],
    })
}

#[tauri::command]
fn capture_layout() -> Result<CaptureLayout, String> {
    let (_, bounds, monitors) = screens_layout()?;
    Ok(CaptureLayout {
        origin_x: bounds.origin_x,
        origin_y: bounds.origin_y,
        width: bounds.width,
        height: bounds.height,
        monitors,
    })
}

#[tauri::command]
fn capture_monitor_previews(max_width: u32) -> Result<Vec<MonitorPreview>, String> {
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
        let png = encode_png(thumb, 1.0)?;
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
fn capture_display(monitor_id: u32, quality_scale: f64) -> Result<CaptureResult, String> {
    let screen = Screen::all()
        .map_err(err)?
        .into_iter()
        .find(|screen| screen.display_info.id == monitor_id)
        .ok_or_else(|| "Selected display was not found".to_string())?;
    let info = screen.display_info;
    let image = screen.capture().map_err(err)?;
    let display_width = image.width();
    let display_height = image.height();
    let png = encode_png(image, quality_scale)?;
    let decoded = image::load_from_memory(&png).map_err(err)?.to_rgba8();
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: decoded.width(),
        height: decoded.height(),
        display_width,
        display_height,
        scale_factor: f64::from(info.scale_factor),
        origin_x: info.x,
        origin_y: info.y,
        monitors: empty_capture_monitors(),
    })
}

#[tauri::command]
fn capture_region(rect: CaptureRegionRect, quality_scale: f64) -> Result<CaptureResult, String> {
    let screens = Screen::all().map_err(err)?;
    let width = rect.width.max(1);
    let height = rect.height.max(1);
    let rx1 = rect.x;
    let ry1 = rect.y;
    let rx2 = rect.x + width as i32;
    let ry2 = rect.y + height as i32;
    struct RegionPiece {
        image: RgbaImage,
        ix1: i32,
        iy1: i32,
        ix2: i32,
        iy2: i32,
    }

    let mut pieces: Vec<RegionPiece> = Vec::new();
    let mut output_scale_x = 1.0_f64;
    let mut output_scale_y = 1.0_f64;

    for screen in screens {
        let info = screen.display_info;
        let sx1 = info.x;
        let sy1 = info.y;
        let sx2 = info.x + info.width as i32;
        let sy2 = info.y + info.height as i32;
        let ix1 = rx1.max(sx1);
        let iy1 = ry1.max(sy1);
        let ix2 = rx2.min(sx2);
        let iy2 = ry2.min(sy2);
        if ix1 >= ix2 || iy1 >= iy2 {
            continue;
        }

        let image = screen.capture().map_err(err)?;
        let scale_x = image.width() as f64 / f64::from(info.width.max(1));
        let scale_y = image.height() as f64 / f64::from(info.height.max(1));
        output_scale_x = output_scale_x.max(scale_x);
        output_scale_y = output_scale_y.max(scale_y);

        let src_x = (((ix1 - info.x) as f64) * scale_x)
            .round()
            .clamp(0.0, image.width().saturating_sub(1) as f64) as u32;
        let src_y = (((iy1 - info.y) as f64) * scale_y)
            .round()
            .clamp(0.0, image.height().saturating_sub(1) as f64) as u32;
        let src_w = (((ix2 - ix1) as f64) * scale_x)
            .round()
            .max(1.0) as u32;
        let src_h = (((iy2 - iy1) as f64) * scale_y)
            .round()
            .max(1.0) as u32;
        let src_w = src_w.min(image.width().saturating_sub(src_x)).max(1);
        let src_h = src_h.min(image.height().saturating_sub(src_y)).max(1);
        let piece = imageops::crop_imm(&image, src_x, src_y, src_w, src_h).to_image();

        pieces.push(RegionPiece {
            image: piece,
            ix1,
            iy1,
            ix2,
            iy2,
        });
    }

    if pieces.is_empty() {
        return Err("Selected region is outside the available displays".to_string());
    }

    let out_width = ((width as f64) * output_scale_x).round().max(1.0) as u32;
    let out_height = ((height as f64) * output_scale_y).round().max(1.0) as u32;
    let mut out = RgbaImage::from_pixel(out_width, out_height, Rgba([0, 0, 0, 0]));

    for mut piece in pieces {
        let dst_x = (((piece.ix1 - rx1) as f64) * output_scale_x).round().max(0.0) as i64;
        let dst_y = (((piece.iy1 - ry1) as f64) * output_scale_y).round().max(0.0) as i64;
        let dst_w = (((piece.ix2 - piece.ix1) as f64) * output_scale_x)
            .round()
            .max(1.0) as u32;
        let dst_h = (((piece.iy2 - piece.iy1) as f64) * output_scale_y)
            .round()
            .max(1.0) as u32;

        if piece.image.width() != dst_w || piece.image.height() != dst_h {
            piece.image = imageops::resize(&piece.image, dst_w, dst_h, imageops::FilterType::Lanczos3);
        }

        imageops::overlay(&mut out, &piece.image, dst_x, dst_y);
    }

    let png = encode_png(out, quality_scale)?;
    let decoded = image::load_from_memory(&png).map_err(err)?.to_rgba8();
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: decoded.width(),
        height: decoded.height(),
        display_width: out_width,
        display_height: out_height,
        scale_factor: (output_scale_x + output_scale_y) / 2.0,
        origin_x: rect.x,
        origin_y: rect.y,
        monitors: empty_capture_monitors(),
    })
}

#[tauri::command]
fn prepare_area_capture() -> Result<CaptureResult, String> {
    let (image, bounds, monitors) = capture_virtual_desktop()?;
    let png = encode_png(image, 1.0)?;
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: bounds.width,
        height: bounds.height,
        display_width: bounds.width,
        display_height: bounds.height,
        scale_factor: 1.0,
        origin_x: bounds.origin_x,
        origin_y: bounds.origin_y,
        monitors,
    })
}

#[tauri::command]
fn prepare_area_capture_for_point(
    cursor_x: Option<i32>,
    cursor_y: Option<i32>,
) -> Result<CaptureResult, String> {
    let (image, screen) = capture_screen_for_point(cursor_x, cursor_y)?;
    let info = screen.display_info;
    let display_width = image.width();
    let display_height = image.height();
    let png = encode_png(image, 1.0)?;
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: display_width,
        height: display_height,
        display_width,
        display_height,
        scale_factor: f64::from(info.scale_factor),
        origin_x: info.x,
        origin_y: info.y,
        monitors: vec![CaptureMonitor {
            id: info.id,
            x: 0,
            y: 0,
            width: display_width,
            height: display_height,
            scale_factor: f64::from(info.scale_factor),
            is_primary: info.is_primary,
        }],
    })
}

#[tauri::command]
fn prepare_area_overlay_for_point(
    cursor_x: Option<i32>,
    cursor_y: Option<i32>,
) -> Result<CaptureResult, String> {
    let screen = screen_for_point(cursor_x, cursor_y)?;
    let info = screen.display_info;
    Ok(CaptureResult {
        png_base64: String::new(),
        width: info.width,
        height: info.height,
        display_width: info.width,
        display_height: info.height,
        scale_factor: f64::from(info.scale_factor),
        origin_x: info.x,
        origin_y: info.y,
        monitors: vec![CaptureMonitor {
            id: info.id,
            x: 0,
            y: 0,
            width: info.width,
            height: info.height,
            scale_factor: f64::from(info.scale_factor),
            is_primary: info.is_primary,
        }],
    })
}

#[tauri::command]
fn crop_capture(png_base64: String, rect: CropRect, quality_scale: f64) -> Result<CaptureResult, String> {
    let bytes = BASE64.decode(png_base64).map_err(err)?;
    let image = image::load_from_memory(&bytes).map_err(err)?.to_rgba8();
    let x = rect.x.min(image.width().saturating_sub(1));
    let y = rect.y.min(image.height().saturating_sub(1));
    let width = rect.width.min(image.width().saturating_sub(x)).max(1);
    let height = rect.height.min(image.height().saturating_sub(y)).max(1);
    let cropped = imageops::crop_imm(&image, x, y, width, height).to_image();
    let png = encode_png(cropped, quality_scale)?;
    let decoded = image::load_from_memory(&png).map_err(err)?.to_rgba8();
    Ok(CaptureResult {
        png_base64: BASE64.encode(png),
        width: decoded.width(),
        height: decoded.height(),
        display_width: image.width(),
        display_height: image.height(),
        scale_factor: 1.0,
        origin_x: 0,
        origin_y: 0,
        monitors: empty_capture_monitors(),
    })
}

#[tauri::command]
fn copy_png_to_clipboard(png_base64: String) -> Result<(), String> {
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

fn protect_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_content_protected(false);
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_content_protected(false);
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.set_focus();
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
        .setup(|app| {
            create_tray(app)?;
            protect_main_window(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            save_pending_capture,
            read_pending_capture,
            delete_pending_capture,
            save_local_capture,
            ensure_device_keypair,
            sign_challenge,
            capture_fullscreen,
            capture_layout,
            capture_monitor_previews,
            capture_display,
            capture_region,
            prepare_area_capture,
            prepare_area_capture_for_point,
            prepare_area_overlay_for_point,
            crop_capture,
            copy_png_to_clipboard,
            platform_label,
            active_window_context,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DendroCapture");
}
