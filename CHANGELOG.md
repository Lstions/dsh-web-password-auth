# Changelog

## 0.8.3

Fixes **"signing in always shows the bare text `forbidden`"**: the login page blocked its own
form submission before any credential check ran.

- The login and first-run pages shipped `Referrer-Policy: no-referrer` — in the response
  header *and* in `<meta name="referrer">`. Browsers treat a native form submission from a
  document whose referrer policy is `no-referrer` as an opaque origin, so `POST /login`
  arrived with **`Origin: null`**. The Host's browser-trust fence refuses `null` as an opaque
  origin (`api-request-trust.ts`: `new URL('null')` throws → deny 403) and the webserver writes
  the 9-byte body `forbidden`. The password verifier never ran, so every credential on every
  browser and device produced the same 403. GET was unaffected — the form rendered fine and
  only the `?token=` URL printed by `dsh web` could get in.
- Both places now declare **`same-origin`**. Cross-site requests still send no `Referer`, but
  a same-origin form submission carries its real `Origin`, which the fence accepts. Redirect
  responses keep `no-referrer` (a redirect's policy does not become the target document's
  policy — verified in Chromium), so one-shot `?token=` URLs still cannot leak through
  `Referer`.
- New regression test asserts the header and the `<meta>` on the first-run page, the login
  page, and the re-rendered login-failure page. It fails on 0.8.2 (verified).

Verified in a real Chromium: with 0.8.2 `POST /login` carried `Origin: null` and got
`403 forbidden`; with this fix it carries the page's own origin, passes the Host's
`isTrustedApiRequest` fence, and lands in the shell. A/B on otherwise identical pages isolates
the cause: `no-referrer` in either the header or the meta alone produces `Origin: null`;
`same-origin` in either restores a real origin.

## 0.8.2

Fixes **"signed in, then every request answers 401 `unauthorized`"** on Hosts newer than
0.2.2-rc.3, which moved the browser-cookie cap onto a separate `authentication-token` row
(default 30 days) while `connection.cookieMaxAgeDays` stayed where it was:

- The plugin now takes the **strictest** `cookieMaxAgeDays` across every Loader row instead
  of reading only `connection`. Before, it read 365 (the value its own patch writes) while
  the Host enforced 30, so it minted year-long cookies the Host rejects on every request —
  sign-in looked successful and then the whole UI returned 401 `unauthorized`.
- The bundle patch also raises `authentication-token.cookieMaxAgeDays` to 365, so year-long
  sessions keep working on those Hosts. That row does not exist on older Hosts, where an
  unmatched patch is a no-op (verified: no boot warning).
- The startup warning now names the row that actually caps the session.

Verified on master: 30/40/365-day cookies all reach the shell, anonymous requests still get
the login page, `/web-auth/status` reports the effective cap. On 0.2.2-rc.3: token → 303,
shell → 200, asset → 200, 121/121 tests.

## 0.8.1

Fixes **HTTP 500 `internal error`** on DSH builds newer than 0.2.2-rc.3 (master), where the
Host moved request admission into `webServer` and removed `connection.requestRejection`:

- `isAuthenticated` now **feature-detects** `connection.requestRejection`. On a Host that
  removed it the call threw `TypeError: ... is not a function`, which the request guard
  turned into `500 internal error` for every page — the exact reported symptom.
- Named routes are registered with an explicit **auth policy**. Newer Hosts default every
  named route to `required`, so the plugin's own pages were answered `401 unauthorized`
  before the plugin ever saw them. Shell routes (`/`, `/index.html`) now use a per-request
  policy — `required` when the request carries a valid session (the Host then hands over a
  Peer), `anonymous` otherwise; `/login`, `/setup` and `/web-auth/*` stay `anonymous`.
  Older Hosts ignore the field entirely.
- The admitted **Peer is forwarded** to the Host shell. `frontend-static` renders with
  `peer.signal` and throws `TypeError: Cannot read properties of undefined (reading
  'signal')` when it receives `undefined`.
- `cameFromLaunchToken` recognises token-exchanged sessions on newer Hosts by "the Host
  admitted it and we did not mint it", because those Hosts handle `?token=` in a
  `webserver/request` waterfall **before** routing, so the plugin no longer sees the
  exchange to record it.

Verified end to end on 0.2.2-rc.3 (published) and on master: token exchange → 303,
shell → 200, static asset → 200, bogus cookie → login page (never the app).

## 0.8.0

Packaging and documentation release (no behaviour change):

- Add `engines.dsh` (`>=0.2.1 <0.3.0-0`) so DSH's compatibility gate judges the
  runtime version instead of silently passing every host.
- Widen the `@deepseek-ai/schemastery` dependency from an exact pin to `^3.18.5`,
  so a host upgrade does not install a second copy of the schema library.
- Add `publishConfig` (`access: public`, tag `latest`) for the first npm release.
- README: registry install command, remove the `/account` instructions that
  contradicted the in-app account surface, document the real TOTP QR flow, and
  correct the test count (121).

## 0.7.6

Fixes primary buttons rendering as an unreadable solid block: the label used
`--dsw-alias-brand-primary-invert`, which has the same value as
`--dsw-alias-brand-primary` in both themes, so the text was black on black on the
light theme and white on white on the dark one. The label now uses
`--dsw-alias-label-primary-foreground`, the token `ui-primitives` uses for its own
primary button (white on the light theme's near-black fill, near-black on the dark
theme's near-white fill).

## 0.7.5

Fixes a launch-token visit landing on **Create your account** instead of the app on a fresh
installation, where the token URL is the only way in.

- **The launch token now enters the app directly.** A session exchanged from the `?token=`
  URL no longer passes through the first-run account gate: `/` hands it to the Host shell,
  and creating the password account moves to **Settings → Security**, which already accepts
  a token session. Opening the plain URL without a token on a machine with no account still
  shows the creation page, and any session that did not come from the token still has to
  create the account first.
- The bypass is limited to sessions recorded at token exchange, so a Host-authenticated
  browser that never exchanged the token keeps the first-run gate.

## 0.7.4

Fixes unreadable primary-button labels in dark mode: the label uses the paired foreground
token instead of a hardcoded colour, so both themes stay legible.

## 0.7.3

Allows a session exchanged from the launch token to create the first account from a remote
origin while `bootstrapLoopbackOnly` is on, and remembers token-exchanged sessions across
restarts so the exemption survives a `dsh web` restart.

## 0.7.2

Makes first-run account creation reachable and race-free: `GET /setup` renders the page
(a refresh or bookmark no longer answers 405 with an empty body), account creation decides
existence inside the credential write lock so concurrent submissions cannot overwrite the
first account, and the non-loopback 403 page no longer renders literal `undefined` keys.

## 0.7.1

Serves the Host shell through its new `{ resource }` fallback shape while keeping the older
function fallback working, and fails closed with a readable 500 when the Host registered no
frontend fallback.

## 0.7.0

Gates `/` and `/index.html` with exact routes instead of taking over the Host fallback seat,
sends a signed-in visitor from `/login` back to the app, and raises the Host cookie cap from
the plugin patch itself.

## 0.6.2

Fixes `the Web frontend is not built` on hosts whose `webServer.renderIndex` takes a
second `peer` argument — the reported failure happened after finishing setup, leaving the
app unreachable while `/login` still worked.

- **Pass `peer` to `renderIndex`.** Newer hosts use it to collect index injection rows and
  throw when it is missing; the plugin called the one-argument form, and the resulting
  exception surfaced as "the frontend is not built". The plugin now passes
  `connection.browserPeer`, exactly as the host does. Verified against the affected host's
  own build: the one-argument call throws, the two-argument call succeeds and keeps the
  injected rows.
- **Degrade instead of failing.** Without a `browserPeer` (older hosts) it uses the
  one-argument signature; if that is refused, it serves the index as-is rather than
  returning an error. A missing injection beats an unusable UI.
- If the index still cannot be read, `/` and `/index.html` are handed back to the host and
  a fixed diagnostic file is written for reporting, instead of serving a bare error page.

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
