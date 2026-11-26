# 빙크샐러드

[한국어](./README.ko.md)

## Run on a phone on the same Wi-Fi

Double-click `start-internal.bat`. It builds the production frontend and starts
the app on the local network. Access is limited to clients on the host's detected
private IPv4 subnets. On first run, open `http://localhost:4173` on
the host computer and create an owner password. Find the computer's private
IPv4 address with `ipconfig`, then open `http://<computer-ip>:4173` on the phone.

Alternatively, run:

```sh
npm install
npm run dev
npm test
```

`npm run dev` starts the Vite frontend and API together. Do not start them
separately. On the first visit, set the owner password (12 characters or more)
to create the `owner` account. After setup, use **Sign up** on the login screen
to create an independent personal ledger with a username and password; Kakao
Login is optional.

Install or repair pip for the active Python interpreter as needed, then install
the Excel parsing dependencies with:

```sh
python scripts\ensure-python-deps.py
```

The development app is served at `http://localhost:5173`; its API listens on
`127.0.0.1:4174`. For the production server, use:

```sh
npm run build
npm run server
```

`npm start` builds the frontend and serves it together with the API from one
server at `127.0.0.1:4173`. `start-internal.bat` uses that production build and
serves on `0.0.0.0:4173`; the server rejects clients outside the host's detected
private IPv4 subnets. Allow Node.js through the firewall on private networks if
the launcher cannot be reached from a phone.

## Connect a Kakao account

Create an app in [Kakao Developers](https://developers.kakao.com/), enable
Kakao Login, enable the REST API key's client secret, and register a redirect
URI that the browser can reach. The registered URI must exactly match
`KAKAO_REDIRECT_URI`.

Set these variables in PowerShell before starting the server:

```powershell
$env:KAKAO_REST_API_KEY = "your REST API key"
$env:KAKAO_CLIENT_SECRET = "your client secret"
$env:KAKAO_REDIRECT_URI = "https://your-stable-domain/api/auth/kakao/callback"
.\start-internal.bat
```

For development, start `npm run dev` from the same PowerShell session instead.
The REST API key and client secret remain server-side. Link your Kakao account
from **Settings**; the login screen then offers Kakao Login. A temporary
Cloudflare URL changes between runs and cannot serve as a registered stable
redirect URI.

## Shared household and KakaoBank accounts

Open **Household management** to create KakaoBank account labels, choose an
optional last four digits, and invite members. Invitation links are single-use
and expire after seven days. Invitees create a username and password. Owners
can grant read-only or edit access, revoke pending invitations, and remove
members. Read-only members can see the shared transactions and dashboard but
cannot add, edit, delete, or import transactions.

Select one of the household's account labels when importing an XLSX statement.
Transactions and duplicate detection are scoped to that account. The app does
not ask for KakaoBank credentials or store full account numbers.

Kakao Login authenticates a Binksalad user; it does not grant access to
KakaoBank account data. Direct bank account discovery/transaction retrieval is
not implemented or verified against an authorized KakaoBank integration.
Statements must be downloaded and imported by the user.

## Use from a different network (temporary HTTPS URL)

Private addresses such as `192.168.x.x` only work on the same local network.
For a quick external test, install `cloudflared` and run:

```sh
npm run external
```

First create the owner password with `start-internal.bat` from the host
computer, then stop the internal server. Install `cloudflared` and run
`start-external.bat` (or `npm run external`). It starts the authenticated
production API and a temporary Cloudflare HTTPS tunnel. Open the printed
`https://...trycloudflare.com` URL on the phone. Press `Ctrl+C` to stop it. The
URL is public to anyone who knows it and expires when the command stops. Do not
expose the Vite development server directly to the internet.

The app stores transactions in the local SQLite database under `data`. Optional
Excel passwords are encrypted with AES-256-GCM using a separate key under
`.secrets`. Back up both securely; never publish them.

The first account is initialized by the owner on the host computer. Kakao
account linking/login are available when the server environment is configured;
a live provider callback still requires valid Kakao Developer credentials and
a stable redirect URI. Shared-household invitations and account-specific XLSX
imports are implemented. Household switching, push/email notifications, and
year-over-year analysis are not implemented. The encrypted sample KakaoBank
statement requires its actual password; the app cannot infer it.

Username/password sign-up is open to people who can reach the server after the
owner initializes it; each signup creates a separate personal ledger. There is
no email verification, so account creation should be considered before exposing
the app to the public internet.
