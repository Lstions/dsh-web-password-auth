# dsh-web-password-auth

Sign in to the DeepSeek Harness Web UI with a **username and password** instead of
the launch token. Sessions persist across browser restarts until you sign out.
Optional TOTP two-factor authentication.

## What it does

| | |
|---|---|
| **Password sign-in** | First visit asks you to create an account; later visits ask for the password |
| **Persistent sessions** | A signed cookie keeps you signed in; no re-authentication per visit |
| **Sign out** | Clears the cookie server-side (the cookie is `HttpOnly`, so only the Host can) |
| **Two-factor (optional)** | TOTP, compatible with any authenticator app |
| **Launch token kept** | The `dsh web` URL still signs you in — it is the local fallback when you forget the password |
| **In-app settings page** | Settings → Security (安全): change the password, turn two-factor on or off, and sign out |

## Install

```sh
dsh plugin --profile web add /absolute/path/to/dsh-web-password-auth
```

Then restart `dsh --profile web` and open the UI. The first visit shows
**Create your account**.

The plugin reads the Host's effective `cookieMaxAgeDays` from the Loader at startup and
**uses the smaller of the two**. Without that, a mismatch would produce cookies the Host
rejects — sign-in would look successful and then fail on every request.

### Making sessions last until sign-out

The Host caps cookie lifetime with `connection.cookieMaxAgeDays` (default 30). This
plugin's `sessionDays` must stay **at or under** that cap, or the Host rejects the
cookie with 401. To get year-long sessions, raise both in your profile patch
(`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- id: connection
  config:
    # A patch replaces the whole config, so restate every key the row needs.
    trustedHosts: !!js ctx.webStartup.trustedHosts
    cookieMaxAgeDays: 365
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `sessionDays` | `365` | Browser session lifetime in days; must be ≤ `connection.cookieMaxAgeDays` |
| `bootstrapLoopbackOnly` | `true` | Before an account exists, only this machine may create it |
| `maxAttempts` | `5` | Failed sign-ins before the source address is locked out |
| `lockoutMs` | `300000` | Lockout duration in milliseconds |
| `minPasswordLength` | `8` | Rejected shorter passwords |
| `totpIssuer` | `'DSH'` | Issuer name shown in authenticator apps |
| `totpAvailable` | `true` | Offer two-factor enrolment on the account page |

## Where the password is stored

In the Harness credential store (`$DSH_HOME/.credentials.yaml`, mode 0600, written
under a cross-process file lock):

- `web-auth/password` — username plus a scrypt hash (`N=32768, r=8, p=1`, about
  66 ms and 32 MB per verification)
- `web-auth/totp` — base32 secret, enabled flag, and the last consumed time step

Plaintext passwords are never written anywhere. The signing key record
`client-connection/browser-session` is read but **never** written — its payload
format belongs to the Host.

## Creating the first account

There are two ways in, and both end at the same record:

| Situation | What happens |
|---|---|
| You open the plain URL (`http://127.0.0.1:3080/`, no `?token=`) and no account exists | The account-creation page renders. Submitting it writes the account and signs you in |
| You open the `?token=...` URL `dsh web` prints | You are already signed in, so no page could be shown. **Settings → Security** offers "Create a password account" instead |

The second case is the common one, because the printed URL carries the token. Without that
in-panel form the token would be a one-way door: you would have to hand-edit the `?token=`
parameter out of the URL to ever set a password.

Both paths are restricted to the machine running the harness while `bootstrapLoopbackOnly`
is on (the default), and both refuse once an account exists.

To start over, remove the `web-auth/password` record from `$DSH_HOME/.credentials.yaml`;
the next visit offers account creation again.

## Visual consistency

The Host-rendered pages cannot read `--dsw-alias-*`: the client stylesheet is not loaded
before sign-in. They therefore carry the values behind those tokens as plain literals —
copied, not invented. A previous revision used a blue primary button while the product's is
near-black, which made the sign-in page look like a different app.

## The settings page

Once signed in, **Settings → Security** (安全) is the normal way to manage the account.
It reads and writes this plugin's own `/web-auth/*` endpoints using the session cookie
the page already has, so it needs no separate authorization step:

| Control | Effect |
|---|---|
| Change username | Updates the label shown on the sign-in screen and in your authenticator entry; sessions stay valid |
| Change password | Writes a new scrypt hash, then revokes every session (you sign in again) |
| Turn on two-factor | Shows a scannable QR code plus the base32 secret; confirms with one code |
| Turn off two-factor | Requires a current code |
| Sign out | Revokes the current session immediately, server-side |

The same section also appears on the plugin's own page under **Plugins → Web Password Auth**,
so people who find the plugin there can manage the account without hunting for it in Settings.
It renders nothing on other plugins' pages.

Account management lives **only** in those two in-app surfaces — there is no standalone `/account` page.
The only Host-rendered pages are the ones that must exist before the app can load:
sign-in (`/login`) and first-run account creation (`/setup`).

The page needs the Client half (`lib/client.js`). It registers into the `settings.section`
slot, so it appears beside General, Models, Plugins, and Agent presets. A running
`dsh web` process picks it up only after a **restart**, because the browser plugin
roster is composed at startup.

The two-factor enrollment step shows a **QR code** (rendered server-side as an SVG data
URI) next to the base32 key. Scanning beats transcribing 32 characters, which is the most
common cause of "enrollment succeeded, sign-in fails".

## Forgot the password

The launch token is the recovery path:

1. Look at the terminal where `dsh web` is running; it prints a URL with `?token=...`
2. Open it — the Host exchanges the token for a cookie and signs you in
3. Go to `/account` and set a new password

This works because both entry points require the same thing: access to this machine.
If the process is supervised and its stdout is discarded, delete the
`web-auth/password` record from `.credentials.yaml` and restart; the next visit
shows the setup page again.

## Security notes

- **Serve over TLS if anything but loopback can reach the port.** A password over
  plain HTTP is readable on the wire, and the launch token leaks through terminal
  logs and process listings. Use `--tls-cert`/`--tls-key`, or terminate TLS in a
  reverse proxy.
- **Full permissions mean sign-in equals remote code execution.** This plugin is
  meant to sit in front of a `danger-full-access` composition. Enable two-factor
  authentication if the port is reachable from anywhere you do not fully trust.
- **Changing the password signs out every session.** The plugin deletes the
  signing key record so all existing cookies stop verifying. Per-session
  revocation is not possible: the cookie payload format is owned by the Host.
- **One user only.** Every authenticated browser shares the Host's owner principal;
  the username is a label on one shared credential, not an account system.
- Failed sign-ins are counted in memory per source address. A restart clears the
  counters.

## How it hooks in without patching the Host

The Host's authentication verdict is "cookie equals HMAC over an authority-bound
payload", and the signing key is a persistent credential record. This plugin
activates after `dsh-client-connection`, reads the same key, and mints its own
cookies. Three public extension points are enough:

1. `webServer.register({ kind: 'exact' })` — exact routes match before the fallback,
   so `/` and `/index.html` can be served by this plugin instead of the Host's
   plain-text 401.
2. `connection.requestRejection()` — reusable Host/Origin fence (DNS-rebinding and
   cross-site defence), combined with this plugin's own cookie check.
3. `webServer.renderIndex()` — renders the boot injections into `index.html`.

Nothing in `packages/` changes, so upgrading the Harness cannot conflict with this
plugin's source. A change to the Host cookie format *would* break it; the plugin
logs a loud diagnosis at activation when the signing-key record does not match the
expected shape.

## Limits

- Sessions are validated against an in-memory copy of the signing key. The plugin
  re-reads it after it triggers a revocation, but an external key rotation needs a
  restart of the row.
- The `/account` page is plain server-rendered HTML, not part of the SPA settings
  dialog. The SPA cannot host it: unauthenticated visitors never receive
  `index.html`, so no client code runs.
- No QR code for TOTP enrolment; the page shows the base32 secret and the
  `otpauth://` URI for manual entry.

## Tests

```sh
node --test "test/*.test.mjs"
```

47 cases: cookie round-trip and rejection paths, scrypt, TOTP against the RFC 6238
vectors, the bootstrap flow, sign-in, rate limiting, password change, two-factor
enrolment and replay rejection, Chinese localisation, and HTTP method handling.

`test/integration.test.mjs` builds a minimal Cordis-shaped harness (a real HTTP
server with the same route precedence) rather than booting the whole Harness, so it
runs without an installed profile. `node_modules/@deepseek-ai/schemastery` in the
test tree is a **local stub** covering only the schema surface this plugin declares;
the real package comes from npm at install time.
