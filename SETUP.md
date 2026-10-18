# Setting up Niall's Toolkit 2.x on Windows, iPhone and Chrome

You end up with three copies of the toolkit, all with the same data:

| Where | What it is | How it gets the data |
|---|---|---|
| **Chrome extension** | What you use now, plus the Amazon "Track seller" button | Syncs through your Google Drive |
| **Windows app** | Its own window, Start menu and taskbar icon (installed from Edge or Chrome) | Syncs through your Google Drive |
| **iPhone app** | An icon on your Home Screen that opens full screen | Syncs through your Google Drive |

It's all free: GitHub hosts the app, Google Drive holds the sync copy (a few MB of your 15 GB), and nothing else is involved.

**How the three stay connected.** Each copy keeps its own data, so it works offline. A few seconds after you change something, and every few minutes while it's open, it saves a compressed copy to a folder in your Google Drive called **Niall's Toolkit Sync** and picks up what your other devices changed. If the same thing was changed in two places, the newer change wins, and deleting something deletes it everywhere. Settings merge field by field, so changing your Keepa key on the phone doesn't undo a target you set on the computer.

Allow about 40 minutes the first time. Do the parts in order.

---

## Part 1: Back up the extension (2 minutes)

1. Open the toolkit in Chrome (the extension you have now).
2. Go to **Backup & restore**, tick **Include API keys and tokens**, and click **Export everything**.
3. Keep the file somewhere safe. If anything goes wrong, **Import everything from a file** puts it all back.

## Part 2: Put the app on GitHub (10 minutes)

GitHub hosts the app's files for free, at an address like `https://yourname.github.io/nialls-toolkit/`. Only the code goes there: your data never does.

1. Create a free account at **github.com** (Sign up). Your username becomes part of the address, so pick something short.
2. Install **GitHub Desktop** from **desktop.github.com** and sign in with that account. It also installs Git, which tracks versions of the project.
3. In GitHub Desktop: **File → Add local repository…** → choose
   `C:\Users\Niall\OneDrive\Documents\FBA Apps\nialls-toolkit`.
   It will say this isn't a repository yet: click **create a repository**, keep the name **nialls-toolkit**, and click **Create repository**.
4. Click **Publish repository**. **Untick "Keep this code private"**: free accounts can only host public projects. The code is public, but it contains no keys, passwords or data.
5. On github.com, open the repository → **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, and click **Save**.
6. Wait a minute, refresh the page, and copy the address it shows, for example `https://yourname.github.io/nialls-toolkit/`.

Your app's address is that, plus `dashboard.html`:
**`https://yourname.github.io/nialls-toolkit/dashboard.html`**. You'll need it in Part 3.

> **Updating later.** When the code changes, open GitHub Desktop, write a short summary, click **Commit to main**, then **Push origin**. The Windows and iPhone apps pick up the new version the next time they open while online.

## Part 3: Google sign-in for sync (10–15 minutes)

The toolkit uses your own Google project, so only you are involved. If you already set one up for the Google Sheet, use the same project and skip to step 4.

1. Go to **console.cloud.google.com** and create a project (for example "FBA Toolkit").
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Sheets API**.
3. **OAuth consent screen** (also called **Google Auth Platform → Branding / Audience**):
   - User type **External**. Any app name; your email as the support and developer contact.
   - Under **Test users**, add your Google account.
   - Click **Publish app** ("In production"). Without this, sign-in stops working after 7 days.
   - When you first sign in, Google says *"Google hasn't verified this app"*. That's expected for a personal project: click **Advanced → Go to … (unsafe)**. You'll only see it once per device.
4. **Credentials → Create credentials → OAuth client ID** (or open the one you already have):
   - Application type **Web application**.
   - Under **Authorised redirect URIs**, add **both** of these:
     - `https://yourname.github.io/nialls-toolkit/dashboard.html` (your address from Part 2)
     - The extension's address, `https://<a long id>.chromiumapp.org/`. To get it, open the extension's **Devices & sync** page after Part 4 and copy it from there.
   - Click **Save**.
5. Copy the **Client ID** (ends `.apps.googleusercontent.com`) and the **Client secret** (starts `GOCSPX-`). If the secret is hidden, click **Add secret** and copy the new one.

Keep the secret private, like a password. The toolkit stores it only on your devices.

## Part 4: Update the Chrome extension (5 minutes)

**Copy the new files over your existing extension folder.** Chrome keeps the extension's data under an ID that comes from the folder it's loaded from. Loading the new version from a different folder gives a new, empty extension.

1. Find the folder the extension is loaded from: open `chrome://extensions`, click **Details** on Niall's Toolkit, and look at **Source**.
2. Copy everything inside `C:\Users\Niall\OneDrive\Documents\FBA Apps\nialls-toolkit` into that folder, replacing the old files.
3. On `chrome://extensions`, click **↻** on the Niall's Toolkit card. It should now show version **2.1.0** (or later), and your data is still there.
4. Open the toolkit and go to **Devices & sync** (new, in the menu):
   - Paste the **Client ID** and **Client secret** from Part 3 and click **Save**.
   - Copy the **redirect address** shown on that page (`https://…chromiumapp.org/`) and add it to your Google OAuth client (Part 3, step 4) if it isn't there yet.
   - Click **Connect Google** and sign in.
   - Click **Turn on sync**. Your data is copied to **Niall's Toolkit Sync** in your Google Drive.

> If you'd rather load the extension from the new folder: Export everything (Part 1), remove the old extension, **Load unpacked** the new folder, then **Import everything from a file**.

## Part 5: The Windows app (3 minutes)

1. Open your app address (`https://yourname.github.io/nialls-toolkit/dashboard.html`) in **Edge** or **Chrome**.
2. Click the **Install** icon at the right of the address bar (a monitor with a down arrow), or use **⋯ → Apps → Install this site as an app**. It now has its own window and appears in the Start menu. Right-click its taskbar icon and choose **Pin to taskbar** if you like.
3. In the app, open **Devices & sync**, paste the **setup code** and click **Use code**. To get the code, open the extension's **Devices & sync → Add another device** and click **Copy setup code**.
4. Click **Connect Google** and sign in. Your data arrives within a few seconds.

## Part 6: The iPhone app (3 minutes)

1. In the **Windows app**, open **Devices & sync → Add another device**. A QR code appears.
2. Point your iPhone's **Camera** at it and tap the link. Safari opens the toolkit, and the setup code is copied for you. If it isn't, tap **Copy setup code** on the page.
3. In Safari tap **Share** (the square with an arrow) → **Add to Home Screen** → **Add**.
4. Open **Toolkit** from your Home Screen. It has its own storage, separate from Safari, so it asks for the setup code: tap **Paste**, then **Use code**.
5. Tap **Connect Google**. Google opens, you sign in, and you come straight back to the app. Your data arrives.

## Part 7: Keys on each device

Each device keeps its own **Keepa API key** unless you choose otherwise. Either:

- type it once on each device (**Settings → Keepa API**), or
- on any device, tick **Devices & sync → Sync my API keys too**, and the others receive it at their next sync.

Your targets, rules and every other setting sync automatically.

---

## Good to know

- **Offline.** The Windows and iPhone apps open without internet once they've been opened online at least once. Changes made offline sync when you're back online.
- **The Amazon "Track seller" button** works only in the Chrome extension. On the iPhone, copy the storefront (or product) link in the Amazon app or Safari, open the toolkit and tap **Storefront tracker → Paste link**.
- **On the go:** **Cash flow → Log a spend** keeps today's budget up to date before the bank statement catches up, and **Invoices → Take a photo** files a receipt straight from the camera.
- **Weekly backups** to Google Drive (Backup & restore) are made by whichever device is open first that week, and kept forever in **Niall's Toolkit Backups**.
- **Receipts and invoices** you add on one device appear on the others, including photos taken on the iPhone.
- **Backups** are still worth making now and then (Backup & restore → Export everything). Sync copies mistakes too, such as deleting the wrong thing.
- **Turning sync off on one device** leaves its data where it is and stops it sending or receiving changes. Your other devices carry on.
- **"Delete everything"** in Settings clears only the device you're on. With sync on, your data comes back from your other devices at the next sync.
- **Is it private?** Your data goes only to your own Google Drive, in a folder the toolkit created. The app can only see files it created itself. GitHub serves the code, never your data.

## If something goes wrong

| Problem | Fix |
|---|---|
| Google says **redirect_uri_mismatch** | The address you're using isn't in **Authorised redirect URIs** (Part 3, step 4). Add it exactly as shown on **Devices & sync**. Changes can take a few minutes to apply. |
| Google says **access blocked / app not verified** | Make sure your account is a **Test user** and the app is **Published** (Part 3, step 3). |
| Sync says **Reconnect** | Sign-in expired or was revoked. Click it and **Connect Google** again. |
| The extension shows no data after updating | It was loaded from a different folder. Remove it, **Load unpacked** the original folder (Part 4), or import your backup. |
| iPhone app looks out of date | Close it fully (swipe it away) and open it again while online. |

## Testing on this computer (optional)

To try the web app without GitHub, run this in PowerShell, then open http://localhost:8080:

```bash
powershell -ExecutionPolicy Bypass -File "C:\Users\Niall\OneDrive\Documents\FBA Apps\nialls-toolkit\tools\serve.ps1"
```

To sign in to Google there, add `http://localhost:8080/dashboard.html` to the redirect URIs as well.
