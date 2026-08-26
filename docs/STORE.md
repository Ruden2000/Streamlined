# Publishing Streamlined to the app stores

Everything that can be prepared without your accounts is done. This is the
remaining path, in order, with the parts only you can do marked **[you]**.

---

## Before anything: two things worth deciding

**1. Is this a public app or a personal tool?**
Today Streamlined is distributed from GitHub and the website, which is fine for
you and people you share it with. Putting it on a store makes it a public
service, which raises the questions in the next point. Nothing below is wasted
if you decide to stay on GitHub — but the effort and the obligations both
step up once it is listed.

**2. Trust & Safety (`ROADMAP.md` Phase 5) is still open.**
`src/scanner.js` blocks a small illustrative keyword list. The
`knownIllegalHashes` set is deliberately empty — there is no licensed
perceptual-hash matching (PhotoDNA / Thorn / Cloudflare CSAM Tool) and no
NCMEC reporting path. For a personal tool that is a reasonable posture. For a
publicly listed service that handles user files, it is a question for a lawyer,
not for code. **Get that answer before paying for developer accounts.**

---

## Android — Google Play

### Step 1 **[you]** — Play Console account
<https://play.google.com/console/signup> — $25, one time.

### Step 2 **[you]** — Generate the Android package
1. Go to <https://www.pwabuilder.com>
2. Enter `https://streamlined-3bu.pages.dev`
3. **Package for stores → Android**
4. Settings that matter:
   - **Package ID:** `com.streamlined.app` — must match exactly, and can never
     change after publishing
   - **Signing key:** *Generate new*
5. Download the zip.

**Save the `.keystore` file and its password somewhere permanent.** Without them
you can never publish an update — the listing would have to be recreated from
scratch.

### Step 3 **[you → me]** — Send me the SHA-256 fingerprint
The zip includes a `signing-key-info.txt` (or PWABuilder shows the fingerprint
on screen). It looks like `AB:CD:12:…`, 32 hex pairs.

Give it to me and I will put it into `public/.well-known/assetlinks.json`,
replacing the `REPLACE_WITH_SHA256_FROM_PWABUILDER` placeholder, and deploy.

**This step is not optional.** Without it Android shows a browser address bar
across the top of the app instead of running it full screen.

### Step 4 **[you]** — Screenshots
Play needs at least 2 phone screenshots. Take them on your own phone — real
screenshots look better than anything generated, and the app is already
installed there. Useful ones: the send screen, the devices list, a transfer in
progress.

Also needed: a **1024×500 feature graphic**. The app icon (512×512) already
exists at `public/pwa-512.png`.

### Step 5 **[you]** — Create the listing
Play Console → *Create app* → Streamlined / English (US) / App / Free.
Then *Testing → Internal testing* → upload the `.aab` from the zip.

Listing copy is in the next section, ready to paste.

---

## Listing copy

**App name:** Streamlined — File Transfer

**Short description** (80 max):
> Fast, private file transfer between your devices. No account, no cloud.

**Full description:**
> Streamlined sends files straight from one of your devices to another — photos,
> videos, documents, anything — with no account, no cloud storage, and no file
> size limits.
>
> **How it works**
> Open Streamlined on two devices and pair them with a six-character code or by
> scanning a QR code with your camera. Files then travel directly between the
> devices. The files themselves never reach our servers.
>
> **Private by design**
> Every transfer is encrypted with AES-256-GCM. Devices agree on a fresh key
> each time they connect, so even someone who later learned your pairing code
> could not read traffic they had recorded earlier. Each connected device shows
> a six-digit verification number you can compare to confirm the connection is
> direct.
>
> **Features**
> • Any file type, any size
> • No account or sign-in
> • End-to-end encrypted
> • Pair up to 6 devices
> • Send whole folders, with their structure intact
> • Paste a screenshot straight in and send it
> • A shared clipboard across your devices
> • Notifications when a file arrives, with the file's name
> • Interrupted transfers resume where they stopped
> • Works between Android, iPhone, Windows and Mac

**Category:** Tools
**Privacy policy URL:** `https://streamlined-3bu.pages.dev/privacy.html`

---

## Play "Data safety" form — draft answers

> **Check every one of these yourself before submitting.** This is a binding
> declaration to Google and getting it wrong is a policy violation. It is written
> from what the code actually does today, but you are the one signing it.

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share user data? | **Yes** (minimal, below) | The signalling service unavoidably sees some data |
| Files and docs | **Not collected** | Transfers are peer-to-peer and encrypted; file contents never reach the server |
| Device or other IDs | **Collected, not shared** — app functionality | A random device ID and, if you enable notifications, a push subscription are held so devices can find each other |
| App activity → other user-generated content | **Collected, not shared** — app functionality | Only a pending notification's file name, deleted as soon as the receiving device collects it and discarded after 5 minutes |
| Approximate location / personal info / financial / health / contacts / messages | **Not collected** | None of these are touched |
| Is data encrypted in transit? | **Yes** | TLS to the signalling service; AES-256-GCM plus DTLS between devices |
| Can users request deletion? | **Yes** | No account exists; leaving a network and clearing history removes everything locally, and the server holds nothing durable |

**Content rating:** complete the questionnaire honestly. Note that the app
transfers user-supplied files and includes on-device content scanning.

---

## Apple — later, on your Mac

Needs a Mac and an Apple Developer account ($99/yr).

Apple is stricter about web-wrapper apps (**Guideline 4.2 — Minimum
Functionality**). A plain PWA wrapper is often rejected. Streamlined already
has genuine native behaviour to point at — background transfer notifications,
the system share sheet, camera QR scanning — and adding a native file picker
would strengthen the case further.

Rough path: add `@capacitor/ios`, `npx cap add ios`, open in Xcode, set the
signing team, archive, upload to App Store Connect, then TestFlight.

---

## Status

| Item | State |
|---|---|
| PWA manifest (id, categories, icons, maskable, share target) | ✅ ready |
| Privacy policy + Terms, hosted | ✅ live |
| Icons (192, 512, maskable) | ✅ |
| Listing copy | ✅ drafted above |
| Data safety answers | ✅ drafted — **needs your review** |
| `assetlinks.json` | ⏳ placeholder — needs the fingerprint from step 3 |
| Screenshots + feature graphic | ⏳ **[you]** |
| Play Console account | ⏳ **[you]** |
| Trust & Safety decision | ⏳ **[you + counsel]** |
