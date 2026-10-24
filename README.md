# Connect

Connect is a self-hosted Wi-Fi subscriber management starter for small ISPs. It includes a working **demo mode** with persistent customers, administrator authentication, server-authoritative session timers, simulated connections, and clearly labeled simulated bandwidth. It does not control a router or measure a real network until a provider implements and configures a supported network adapter.

## Requirements

- Node.js 24 or later (uses Node's built-in `node:sqlite`; no `npm install` is needed)
- Windows 10/11, macOS, or Linux

## Start Connect

From this folder, run `npm start`, then open <http://localhost:3000>. The first demo login is `admin@connect.local` / `ConnectDemo!2026`. Change the password before exposing the server to anyone else. Set `CONNECT_ADMIN_PASSWORD` before the first start to choose a different initial password. The initial administrator is only created for a new database.

To stop the application, press Ctrl+C in its terminal. The database is created at `data/connect.sqlite` and survives restarts.

### Windows quick start

1. Install Node.js 24 LTS or newer from <https://nodejs.org/>.
2. Extract the Connect ZIP and open PowerShell in the extracted `connect` folder.
3. Run `npm start` and visit <http://localhost:3000>.
4. Sign in with the demo credentials above, then change the password in **Settings**.

PowerShell can set a first-run password before starting:

```powershell
$env:CONNECT_ADMIN_PASSWORD = "replace-with-a-unique-password"
npm start
```

## Modes and network integrations

`CONNECT_MODE` defaults to `demo`. Demo connection buttons create simulated connection events; the bandwidth display and stress test are simulated. The dashboard and timers are real application behavior, persisted in SQLite and calculated on the server. A short-term timer starts on a successful demo connect, pauses on disconnect, resumes from its saved remainder, and expires server-side. Monthly and unlimited plans have no short-term countdown.

Setting `CONNECT_MODE=production` deliberately disables simulated connection controls and labels measurements as unavailable. Production mode is **not a ready-to-use router integration**: a provider-specific adapter must be implemented, reviewed, and configured before Connect can observe or enforce access on real equipment. It must map authenticated device/account identities to customers, report connection events, enforce expired access, and provide real traffic measurements. Router credentials are not accepted by the browser or included in this demo.

Integration references (read the documentation for the exact RouterOS version and deployment):

- MikroTik RouterOS REST API, including supported HTTP methods and configuration paths: <https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API>
- MikroTik RouterOS RADIUS client configuration: <https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS>
- RADIUS accounting protocol, RFC 2866: <https://www.rfc-editor.org/rfc/rfc2866>

For a real integration, the ISP must provide the controller/router make and exact model, firmware/version, topology, management endpoint and network reachability, an authorized least-privilege service account or RADIUS configuration, customer-to-device identity mapping, the desired captive portal/access policy, accounting/event delivery details, and approved download/upload/ping measurement sources. Validate access revocation and failure behavior in a lab before production use. Do not expose management APIs to the public internet.

## Security and operations

- Passwords use Node's scrypt password hashing; login sessions are random, expiring, server-side tokens in SQLite and cookies are HttpOnly and SameSite=Strict.
- All application API endpoints except login and status require an administrator session. Customer, subscription, and connection changes are validated and audited.
- A payment-record table is present for future reconciliation, but no payment endpoint, M-Pesa workflow, or payment processor is enabled.
- Set `CONNECT_MODE=production`, `CONNECT_ADMIN_PASSWORD`, and `CONNECT_COOKIE_SECURE=true` when deploying behind HTTPS. Use a reverse proxy with TLS, restrict network access, rotate credentials, and manage OS file permissions. The default demo password and HTTP localhost setup are not suitable for public hosting.
- For online hosting, deploy on a secured Node.js 24 host with a persistent disk, back up the database, set environment variables in the host's secret manager, and terminate HTTPS at a trusted reverse proxy. No cloud hosting or router integration is provisioned by this repository.

## Backup and restore

Stop Connect first so SQLite has no open writes. Copy `data/connect.sqlite` to a protected backup location. Restore by stopping Connect and replacing that file with the backup. Store backups encrypted and test restoration; they contain customer and administrator data.

## Tests and ZIP

Run `npm test` for API, timer, authorization, validation, and persistence tests. Create a source ZIP from the project directory with `npm run package`; it writes `dist/connect.zip`, excluding the database, dependencies, and generated archives.

## Netlify deployment

Netlify hosts the Connect **frontend and same-origin API proxy**. It does not run this project's SQLite-backed Node server as a persistent service. The API and its SQLite database must remain on a separate Node.js 24 host with persistent disk. Do not deploy the Netlify frontend without configuring that API if you need login or customer workflows.

1. Deploy this repository through Netlify's Git integration. The included `netlify.toml` runs `npm run build:netlify`, publishes `dist/`, and installs the API proxy function.
2. Host the Connect server separately over HTTPS on a Node.js 24 service with persistent disk. Set `CONNECT_MODE=production`, a unique `CONNECT_ADMIN_PASSWORD`, and `CONNECT_COOKIE_SECURE=true`; retain the provider adapter limitations described above.
3. In Netlify site environment variables, set `CONNECT_API_URL` to the HTTPS **origin only**, such as `https://connect-api.example.com` (no path or trailing endpoint). Redeploy the site.
4. Netlify routes browser `/api/*` calls through its same-origin function to that API. If `CONNECT_API_URL` is missing or unreachable, the UI shows an API configuration error rather than demo data.

To build a self-contained Netlify deploy directory locally, run `npm run build:netlify`. The generated `dist/` contains the static assets, proxy function, and its Netlify configuration. For standalone CLI deployment, install/authenticate the Netlify CLI, link a site, then run `netlify deploy --prod --dir .` from inside `dist/`. Alternatively, connect this repository to Netlify and let it build from the root `netlify.toml`. Set `CONNECT_API_URL` in the Netlify site's environment variables in either case. The deploy directory does not contain customer data, API secrets, or the persistent backend.

## Troubleshooting

- **SQLite unavailable:** Install Node.js 24 or newer and run `node --version`.
- **Port is busy:** Set `PORT` to another local port, for example `PORT=3001 npm start` (PowerShell: `$env:PORT=3001; npm start`).
- **Login fails:** The first-run password only seeds a new database. If the database already exists, changing `CONNECT_ADMIN_PASSWORD` does not reset it. Do not delete a production database to recover access; use a reviewed administrative recovery procedure.
- **Production shows no connections:** This is expected until a provider-specific, tested adapter is implemented and configured. Demo data is never presented as real measurements.
- **Netlify login or API requests fail:** Confirm `CONNECT_API_URL` is an HTTPS origin, the API host is publicly reachable over HTTPS, and the separately hosted Connect server is running with `CONNECT_COOKIE_SECURE=true`.