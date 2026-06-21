# Windows And OAuth Verification

DendroCapture has two independent trust checks:

1. Windows/browser download trust for `DendroCaptureInstaller_*.exe`.
2. Google OAuth trust for the Google Drive consent screen.

Fixing one does not fix the other.

## Windows Download Warning

Browser warnings such as "not commonly downloaded", "not safe", or "malicious" are usually caused by an unsigned or low-reputation Windows installer. DendroCapture must ship signed production installers.

### Can This Be Fixed For Free?

For a public `.exe` installer distributed from the Dendro Studios website, realistically no. Windows needs a signature that chains to a trusted code-signing authority, and that normally requires either:

- Microsoft Artifact Signing / Trusted Signing, which requires a paid Azure subscription and a paid signing plan.
- A traditional OV/EV Authenticode code-signing certificate from a trusted certificate authority.

No-cost alternatives exist, but they do not fully solve public `.exe` download trust:

- Microsoft Store MSIX distribution: Microsoft signs Store-packaged MSIX apps after certification, so you do not manage a certificate yourself. This is the best no-certificate route, but it means publishing through the Store and packaging/release flow changes.
- Self-signed certificate: useful only for internal testing when every machine manually trusts that certificate. It will not make random users' browsers or Windows trust the installer.
- Microsoft Defender false-positive submission: useful if the signed or unsigned installer is incorrectly detected as malware, but it does not replace Authenticode signing or SmartScreen reputation.
- ZIP distribution: can reduce direct `.exe` download friction in some browsers, but the extracted `.exe` is still unsigned and can still trigger SmartScreen/browser reputation warnings. Use `npm.cmd run package:installer:zip` after building an installer, or `npm.cmd run build:installer:zip` to build and zip in one step.

For public website downloads, the lowest-friction professional route is paid signing. The least expensive Microsoft route is usually Artifact Signing Basic, then building reputation over time with signed releases.

The recommended DendroCapture path is Microsoft Artifact Signing. It is cloud-backed Authenticode signing, so release builds can be signed locally or in CI without storing a `.pfx` file in the repo.

### One-Time Artifact Signing Setup

1. Create or use the Azure tenant/subscription owned by Dendro Studios.
2. In the Azure portal, create an Artifact Signing account.
3. Complete identity validation for the publisher identity. The signed installer should show the verified Dendro Studios publisher name.
4. Create a certificate profile for public-trust code signing.
5. Grant the release account or CI identity permission to sign with that Artifact Signing account/profile.
6. Install the Windows SDK Build Tools so `signtool.exe` exists.
7. Install Microsoft Artifact Signing Client Tools so `Azure.CodeSigning.Dlib.dll` exists.
8. Copy the sample metadata:

```powershell
Copy-Item .\src-tauri\artifact-signing.metadata.sample.json .\src-tauri\artifact-signing.metadata.json
```

9. Edit `src-tauri/artifact-signing.metadata.json` with the values from Azure:

```json
{
  "Endpoint": "https://<region>.codesigning.azure.net",
  "CodeSigningAccountName": "<artifact-signing-account-name>",
  "CertificateProfileName": "<certificate-profile-name>",
  "CorrelationId": "dendrocapture-release"
}
```

`artifact-signing.metadata.json` is gitignored because it is release-machine configuration.

10. Sign in to Azure with the account that has signing permission:

```powershell
az login
```

11. Build a signed installer:

```powershell
npm.cmd run build:installer:signed
```

The signed build uses `src-tauri/tauri.signing.conf.json`, which calls `src-tauri/sign-windows-artifact.ps1` through Tauri's `signCommand`. Normal `npm.cmd run build:installer` still builds unsigned local/dev installers.

### Verification

Before uploading a release, verify both the installed app executable and the installer:

```powershell
Get-AuthenticodeSignature .\src-tauri\target\release\dendro_capture.exe
Get-AuthenticodeSignature .\dist-installer\DendroCaptureInstaller_*.exe
```

Both should report `Status : Valid` and `SignerCertificate` should show Dendro Studios or the verified publisher identity. The script also runs `signtool verify /pa /tw /v` during signing.

Release rules:

1. Distribute signed installers from the official Dendro Studios domain.
2. Do not send unsigned `.exe` builds to public testers unless the warning is expected.
3. If Microsoft Defender still flags the signed installer as malware or unwanted software, submit the file to Microsoft Security Intelligence as a false positive.

### Fallback: Traditional OV/EV Certificate

If Artifact Signing is not available, buy an OV or EV Authenticode code-signing certificate from a trusted CA and configure a separate `signCommand` that calls `signtool sign` with that certificate provider. Do not commit `.pfx`, token PINs, or certificate passwords.

Important: SmartScreen reputation is not instant. A newly signed installer can still show an "unrecognized app" warning until Microsoft sees enough clean installs and reputation. A valid signature shows the publisher and is the baseline requirement for a normal public release.

References:

- Tauri Windows signing: https://v2.tauri.app/distribute/sign/windows/
- Microsoft SmartScreen reputation: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Microsoft SignTool: https://learn.microsoft.com/en-us/dotnet/framework/tools/signtool-exe
- Authenticode timestamping: https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures
- Microsoft file submission: https://www.microsoft.com/en-us/wdsi/filesubmission

## Google OAuth "App Not Verified"

Google Drive linking uses OAuth. If users see a Google "app not verified" or "access blocked" warning, the OAuth project has not completed the required Google setup for the account type and scopes.

For private testing:

1. Keep the Google OAuth app in Testing.
2. Add every tester's Gmail account under Audience test users.
3. Make sure the app audience is External for normal Gmail accounts.
4. Make sure the Drive API is enabled.
5. Use a Desktop app OAuth client and paste both the Client ID and Client Secret from that same client into DendroCapture.

For public distribution:

1. Dendro Studios should own the Google Cloud project.
2. Configure the OAuth consent screen with the real app name, support email, home page, privacy policy, and terms URLs.
3. Verify the authorized domains.
4. Submit the OAuth app for Google's required brand/scope verification before inviting broad external users.
5. Ship the verified Dendro Studios OAuth client through the app or backend flow instead of asking every user to create their own Google Cloud project.

References:

- Google unverified apps: https://support.google.com/cloud/answer/7454865
- Google OAuth consent setup: https://developers.google.com/workspace/guides/configure-oauth-consent
- Google OAuth brand verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
