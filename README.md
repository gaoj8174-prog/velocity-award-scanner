# Velocity Award Scanner

A browser userscript that scans Virgin Australia Velocity reward flights for availability across a date range and multiple routes — without clicking through each date manually.

![Velocity Award Scanner](https://img.shields.io/badge/Tampermonkey-Script-blue)
![Version](https://img.shields.io/badge/version-1.0-green)

## Features

- Scan any date range across multiple origin/destination pairs simultaneously
- Results appear in real time as each date is checked
- Click any result pill to see full flight details (segments, departure/arrival times, seats, points, taxes)
- **Book this flight** button opens the VA booking page pre-filled with the correct date and route
- Filter results by fare brand (Business Reward, Business, Premium Reward, Economy Reward)
- Non-stop flights highlighted with a green glow
- Promo code support
- Settings (routes, dates, promo) saved between sessions

---

## Installation

### Step 1 — Install Tampermonkey

Tampermonkey is a free browser extension that runs userscripts like this one.

| Browser | Link |
|---------|------|
| Chrome | [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) |
| Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |
| Safari | [App Store](https://apps.apple.com/app/tampermonkey/id1482490089) |

1. Click the link for your browser above
2. Click **Add to Chrome** (or equivalent) and confirm the installation
3. You should see the Tampermonkey icon (a dark circle with two overlapping circles) appear in your browser toolbar

### Step 2 — Install the script

1. Open the [raw script file](../../raw/main/velocity-award-scanner.user.js)
2. Tampermonkey will automatically detect it and show an installation prompt
3. Click **Install**

That's it. The scanner panel will appear at the bottom-right corner of the page whenever you visit `book.virginaustralia.com`.

---

## How to use

1. Go to [book.virginaustralia.com](https://book.virginaustralia.com) and do **one flight search** — this takes you to the `/dx/VADX/` booking page where the scanner activates, and also initialises the API connection it needs
2. The scanner panel appears at the bottom-right — click the header bar to expand/collapse it
3. Enter your **origins** and **destinations** (comma-separated IATA codes, e.g. `SYD,MEL` and `HND,NRT`)
4. Set your **date range**
5. Optionally enter a **promo code**
6. Click **Scan**

Results appear live as each date is checked. Click any coloured flight pill to see full details and a direct booking link.

### Fare brand colours

| Badge | Fare type |
|-------|-----------|
| `RB` | Business Reward (award points, business cabin) |
| `BU` | Business (revenue fare, business cabin) |
| `RP` | Premium Economy Reward |
| `RE` | Economy Reward |
| `RF` | First Reward |

Non-stop flights are highlighted with a green border.

---

## Troubleshooting

### Scanner panel not showing up

The most common cause is Chrome blocking the Tampermonkey extension from running on the page.

1. Click the **Tampermonkey icon** (the dark circle) in your browser toolbar
2. If you see a banner saying **"Please enable the `Allow User Scripts` extension setting"** — click it and follow the prompt to allow the extension on this site
3. Reload the page — the scanner panel should appear at the bottom-right corner

If the banner is not shown, go to **chrome://extensions** → find Tampermonkey → click **Details** → make sure **"Allow on all sites"** or access to `book.virginaustralia.com` is enabled.

> **Note:** The scanner only activates on `book.virginaustralia.com/dx/VADX/` — the booking flow page. Navigate there first by doing a flight search on the Virgin Australia website.

---

### Scan stops after a few requests

If scanning stops early with a "Stopped after 5 errors" message, open **DevTools → Console (F12)** and look for `[VA Scanner]` log entries. Common causes:

| Symptom in console | Cause | Fix |
|--------------------|-------|-----|
| `Network error` | GM_xmlhttpRequest blocked | Check Tampermonkey has permission for `book.virginaustralia.com` |
| `JSON parse error` | API returned non-JSON (e.g. login redirect) | Do a fresh flight search on the page to re-establish the session, then scan again |
| `Context creation failed` | Missing `x-sabre-storefront` header | Navigate to the flight results page first so the scanner can capture the API token |

---

## Notes

- Requests are spaced ~1 second apart to avoid rate limiting
- Scanning more than 200 dates will prompt for confirmation
- The script only reads publicly available fare data — no login required
- Results reflect availability at the time of scan and may change

---

## License

MIT
