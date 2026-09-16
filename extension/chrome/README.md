# Anjadhe Reader — Chrome companion extension

A one-button companion to the Anjadhe desktop app. Click it on any article
and the page is handed to Anjadhe on this Mac, where the News reader
fetches the article, has your own AI model summarize it, and — when the
page will not load (a paywall, a bot wall, a consent wall) — searches for
coverage of the same story from other sources and summarizes that instead.
You get to read what happened without reading it at the source.

Everything the app does with the link is the News reader's existing
pipeline (`js/apps/news/news-app.js`, `_loadSummary`): article text →
summary; unreadable → search coverage → summary; no model → plain extract;
nothing → an honest "could not be read" with the link.

## What it sends, and where

- Only the current tab's **address and title**, only when you click, only
  to the Anjadhe app on this machine, as an `anjadhe://read?url=…&title=…`
  link. The title travels because a paywalled page shows its headline in
  the tab and little else, and that headline is what the coverage search
  runs on.
- The extension never reads page content, makes no network requests and
  stores nothing. Permissions are `activeTab` (the tab's URL and title
  when you click) and `contextMenus` (the two right-click items).
- What leaves the Mac after that is the app's own business and follows
  its usual rules: the fetch goes to the publisher, the coverage search to
  the search provider you chose, and the summary to the brain you picked.

## Install (unpacked, for now)

1. Install Anjadhe (a packaged build — the `anjadhe://` scheme is registered
   by the app bundle's Info.plist, so a source checkout run with `npm start`
   does not answer these links). Launch it once.
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load
   unpacked** → pick this folder (`extension/chrome`).
3. Pin **Anjadhe Reader** to the toolbar.
4. On an article, click the button (or press **Alt+Shift+R**, or right-click
   → **Read this page in Anjadhe** / **Read this link in Anjadhe** on a link).
   Chrome asks "Open Anjadhe?" the first time — tick *Always allow* for
   this site if you want, and the tab stays where it was.

No Web Store listing yet. Chrome may show a "developer mode extensions"
reminder on launch; that is the price of unpacked.

## Doors on the app side

- `anjadhe://read?url=<http(s) URL>[&title=<page title>]` — parsed and
  validated by `js/main/deep-link.js` (http(s) targets only; anything else
  is dropped and logged). Delivered to the renderer hold-then-consume, so a
  link that launches the app cold is not lost.
- `AppManager.handleDeepLink` routes `read` to `NewsApp.openUrl(url,
  {title})`. With the News package uninstalled the app says so in a toast
  rather than opening the page in Browse.
- The same door is in the app without the extension: paste a link into the
  News search box and press Enter (or click **Read this link**).

## Files

- `manifest.json` — MV3, `activeTab` + `contextMenus`, the `Alt+Shift+R`
  command.
- `background.js` — the service worker: builds the link, navigates the
  current tab at it, flashes a badge.
- `icons/` — generated from `build/icon.png` (`sips -z N N`); regenerate
  after `npm run build:icons` changes the app icon.
