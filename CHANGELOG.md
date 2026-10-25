# Changelog

## 0.3.1

- **Create the password account from the settings panel.** `dsh web` prints a `?token=`
  URL, so opening it lands you in the app already signed in — the old `/setup` page was
  unreachable without hand-editing the URL. The Security section now shows a
  "Create a password account" form whenever no account exists.
- Fixed: changing the username with no account record returned success while writing
  nothing (`modifyRecord` treats a declined mutate as a no-op). It now returns 409
  `noAccount`, as does changing the password.

## 0.3.0

- **Account management moved into the app.** The standalone `/account` page is gone; the
  Security settings section is the only place to change the password, the username,
  two-factor authentication, or sign out. Host-rendered pages are now just `/login` and
  `/setup`, which must exist before the app loads.
- **Change username** from the panel (1-64 letters, digits, `.`, `_`, `@`, `+`, `-`).
  Sessions stay valid because the username is a label, not a credential.
- **QR code for two-factor enrollment**, generated server-side as an SVG data URI. Tests
  rasterize the emitted SVG and decode it with a real QR reader to prove the image carries
  the exact `otpauth://` URI.
- Fixed: calling `totp/begin` while two-factor was already on replaced the enabled record
  with an unconfirmed draft, silently turning it off without a code. It now returns 409.

## 0.2.0

- **In-app settings page.** A new Security section under Settings manages the password,
  two-factor authentication, and signing out, backed by JSON endpoints under `/web-auth/`.
- **Session lifetime follows the Host.** The plugin reads the connection row's effective
  `cookieMaxAgeDays` and clamps to it, so a mismatch can no longer produce cookies the
  Host rejects.
- Fixed: the Connection row was looked up by a bare `connection` id, which never matched
  the real `include:connection` entry — session revocation silently never restarted it.

## 0.1.0

Initial release.

- Username and password sign-in for the Web UI, replacing the launch-token-only flow.
- First-run account creation, restricted to loopback sources by default.
- Signed session cookie with configurable lifetime; sign-out clears it server-side.
- Optional TOTP two-factor authentication with replay rejection.
- Password change revokes every existing session by rotating the signing key record.
- Bilingual UI (English and Chinese), following the system colour scheme.
- The launch token stays available as the local fallback entry point.
