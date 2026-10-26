# Changelog

## 0.6.1

Fixes for `the Web frontend is not built` reported from a second machine after finishing
setup — the app shell was unreachable there.

- **Candidates are verified before use.** The Host's configured `distIndex` was returned
  unchecked; when it pointed at a path that no longer exists, every authenticated request
  to `/` failed with that message. Every candidate is now checked for existence first.
- **More layouts are covered.** Besides the package name, the resolution now probes a
  source checkout's `apps/web/dist`, a flat `node_modules` install, and the pnpm store,
  starting from the running entry point, the working directory, and the plugin itself.
- **Failing to locate the index no longer breaks the UI.** If nothing resolves, the plugin
  releases `/` and `/index.html` back to the Host and redirects once; the Host's own static
  server then serves the app, and the login and setup pages keep working. A missing path
  degrades the login gate, never the app.

## 0.6.0

Two defects reported from a real install on a second machine.

- **Authenticated users could be locked out of the UI.** The plugin resolved the frontend
  `index.html` by resolving `@deepseek-ai/dsh-web-frontend` from its own module location.
  That layout assumption holds when the plugin sits in a workspace checkout and breaks
  elsewhere: the resolution lands on a package with no `dist/`, and every authenticated
  request to `/` returns "the Web frontend is not built" instead of the app. The frontend
  path is deployment knowledge the Host already computed, so the plugin now reads
  `distIndex` from the `frontend-static` fiber through `ctx.registry` and only falls back to
  resolving the package (now verifying the file exists) when that is unavailable.
- **A stale account record bypassed first-run setup.** When a password record existed,
  `/` served the app to token-authenticated sessions and `/login` served a form, so the
  owner never saw account creation. No account must mean first-run setup, whoever is
  asking: `/` now renders the setup page before any token or session handling.

## 0.5.0

Interface pass on the Host-rendered pages and the security panel, from a measured UI audit.

- **The entry pages now use the product's own colors.** The primary button was blue while the
  product's primary is near-black (`#0f1115` light, `#f9fafb` dark); the page carried 17
  hand-picked literals and no product token. It now copies the values behind
  `--dsw-alias-*` rather than inventing a palette. Font weight dropped to 500, radius to 8px,
  and control height to 36px to match.
- **Keyboard focus is visible** on every input and button. Previously the pages removed the
  outline and only recolored the border.
- **Failed sign-in is announced**: the error carries `role="alert"`, and focus moves to the
  password field so a retry needs no mouse.
- **Muted text now clears WCAG AA** (5.4:1, was 3.7:1); the palette uses the product's
  secondary ink for labels and hints.
- Panel: **the QR code no longer overflows**. At a 480px viewport the content column is
  196px, so a fixed 236px image forced horizontal scrolling; it now scales (`max-width`).
- Panel: loading state uses a spinner instead of a line of text, inputs and buttons have
  focus rings, disabled primary buttons dim as a whole instead of leaving 3.7:1 text, and
  both save buttons share one weight.
- **Changing the password now explains the sign-out**: the redirect carries
  `?notice=passwordChanged` and the sign-in page says every session was signed out.

## 0.4.0

- **The security section also renders on the plugin's own detail page** (`Plugins → Web
  Password Auth`), not just in Settings. The `plugins.detail.section` slot renders on every
  plugin's page, so the entry matches the subject and returns null for anything that is not
  this package.
- Fixed: the detail-page section drew its own heading on top of the component's, showing
  "Sign-in and security" twice.

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
