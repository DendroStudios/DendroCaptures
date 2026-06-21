# DendroCapture

DendroCapture is a lightweight desktop screenshot companion built with Tauri, React, and Rust. It captures a PNG, copies it to the system clipboard, and stores the capture locally by default. When paired with Dendro Assets, it can also upload captures to DendroWebsite and optionally open the uploaded image.

The public app is usable without a Dendro account: unpaired captures stay on the local machine and are never uploaded.

## Features

- Capture a selected area or a full display.
- Multi-monitor support.
- Instant PNG clipboard copy.
- Local capture history when unpaired.
- Optional Dendro Assets upload when paired.
- Configurable shortcuts.
- Output scale control for smaller captures.
- Optional self-hide during capture, so clean captures stay clean while app/menu screenshots remain possible for debugging.
- Metadata capture for date, platform, mode, resolution, quality, active app, and window title when available.
- Tray support so the app can keep running after the main window is closed.
- Frameless Dendro-styled window controls instead of the native desktop title bar.

## Local Setup

1. Install Node.js 20+.
2. Install Rust for Tauri:
   - Windows: install Rust with `rustup`, using the stable MSVC toolchain.
   - macOS: install Xcode Command Line Tools, then install Rust with `rustup`.
3. Install dependencies:

```powershell
cd C:\Prods\DendroCapture
npm.cmd install
```

4. Run the app:

```powershell
npm.cmd run dev
```

5. Build installers:

```powershell
npm.cmd run build
```

## Local-Only Mode

If the app is not paired, every capture is:

- copied to the system clipboard as PNG;
- saved under the app data directory in `local-captures/YYYY-MM`;
- listed in the in-app `History` tab;
- kept off the network.

This is the default mode for community users and contributors.

## Optional Dendro Pairing

Dendro pairing is for Dendro Studios infrastructure or compatible self-hosted deployments. The desktop app talks only to the DendroWebsite API. It never talks directly to the Mac mini worker.

Required DendroAPI env:

```env
CAPTURE_PUBLIC_API_URL=https://api.example.com/api
CLIENT_URL=https://example.com
MAC_HUB_URL=<private-mac-worker-url>
MAC_HUB_SHARED_SECRET=<shared-secret>
DENDRO_ASSETS_MAX_BYTES=5368709120
DENDRO_ASSETS_CHUNK_BYTES=8388608
```

Required Mac mini worker env stays on the worker service. It must use the same `MAC_HUB_SHARED_SECRET` expected by DendroAPI and whatever storage-root setting the worker already uses for Dendro Assets. The Website API forwards signed upload/finalize tasks; it does not mount or write the Mac storage path directly.

For local development with a DendroWebsite API:

```env
CAPTURE_PUBLIC_API_URL=http://localhost:3001/api
CLIENT_URL=http://localhost:4321
```

Frontend env still needs its normal public API URL:

```env
PUBLIC_API_URL=https://api.example.com/api
VITE_API_URL=https://api.example.com/api
```

## Pairing Flow

1. Log in to DendroWebsite as an admin.
2. Open `Dendro Assets`.
3. Go to the `Captures` tab.
4. Click `Capture App Pairing`.
5. Copy the generated one-time code.
6. Open DendroCapture, go to `Settings`, paste the code, then click `Pair`.

The app creates an Ed25519 device key locally and stores the private key in OS secure storage:

- macOS: Keychain
- Windows: Credential Manager

The server stores only the public key and issues short-lived capture JWTs after signed challenges.

## Capture Upload Flow

1. DendroCapture captures the PNG and copies it to the clipboard.
2. If unpaired, it stores the PNG locally and stops there.
3. If paired, it uploads PNG chunks to `DendroAPI` through `/api/capture/assets/uploads`.
4. `DendroAPI` forces the asset kind to `image`, applies safe capture metadata, and creates a DendroAsset upload session.
5. `DendroAPI` forwards chunk/finalize work to the Mac mini worker through the existing HMAC-protected `MAC_HUB_URL` contract.
6. The worker stores the PNG in the Dendro Assets storage root and returns storage keys, checksum, size, and image metadata.
7. `DendroAPI` marks the new asset ready and returns a one-time browser handoff URL.
8. If `Open image online after upload` is enabled, DendroCapture opens that URL and DendroWebsite opens the Dendro Assets `Captures` tab with the new capture selected.

## Release Verification

Public Windows installers must be signed before distribution. See [docs/windows-and-oauth-verification.md](docs/windows-and-oauth-verification.md) for the Windows SmartScreen, browser download, and Google OAuth verification checklist.

## Capture Metadata

Captured assets use searchable metadata and tags such as:

- `capture`
- `screenshot`
- platform (`windows`, `macos`, etc.)
- capture mode (`area` or `fullscreen`)
- year/month tags
- resolution tags like `1920x1080`
- active app or window title tokens when available

The asset metadata stores capture date, mode, display dimensions, output dimensions, scale factor, quality scale, platform, app version, device id, active app, and active window title.

## Repository Hygiene

This repository intentionally excludes:

- local `.env` files;
- installer/build output;
- Tauri build targets;
- generated app caches;
- private keys and certificates;
- editor and local assistant state.

Do not commit real API URLs with secrets, device keys, pairing codes, private worker addresses, or generated capture files.

## Current MVP Limits

- Captures are PNG only.
- Annotation, OCR, AI image understanding, Android support, and richer gallery tools are planned after the capture pipeline is stable.
