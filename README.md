# Item Tracker

An app that helps you find your things, and works with no internet.

- **Left-behind alarm** for Bluetooth tags: if a linked tag goes out of range, your phone sounds an alarm and saves where it happened.
- **Make it beep**: ring a Bluetooth tag to find it under the sofa.
- **"Left it here"**: save where you put anything (wallet, bike, car) with GPS and a note.
- **Walk-back compass**: an arrow and the distance lead you back to an item's last spot, without internet.
- **Map** of last-seen spots. Areas you've looked at stay available offline.

Your data stays on your device. There's no account and no server.

**Open it:** https://itsmexavv.github.io/item-tracker/

## Install it

Open the link once while online. After that it works with no internet.

| Device | How |
| --- | --- |
| Android (Chrome) | Open the link, then ⋮ menu → **Install app** (or **Add to Home screen**). |
| iPhone (Safari) | Open the link, then Share → **Add to Home Screen**. Bluetooth features aren't available on iPhone. |
| Windows or Mac (Chrome or Edge) | Open the link, then click the install icon in the address bar. |

## Using it

1. Tap **＋ Add item**, give it a name and pick an icon.
2. For a Bluetooth tag, tap **Link Bluetooth device** and choose it from the list.
3. Before you head out, tap **Start monitoring** and keep the app open on screen. The screen stays on while monitoring.
4. If a tag goes out of range, the alarm sounds and its spot is saved. Tap **Find it** and follow the arrow back.
5. For things without Bluetooth, tap **📍 Left it here** when you put them down.

## Which Bluetooth devices work?

- **Best:** cheap BLE "iTag" anti-lost key finders, a few dollars online. They can beep, report their battery, and their button rings your phone.
- **Maybe:** smartwatches, fitness bands and earbuds. Many refuse a second connection while they're paired to your phone, so try yours.
- **No:** AirTag, Tile and Samsung SmartTag only work with their own apps.

## Limits

- Bluetooth monitoring only works **while the app is open on screen**. A web app can't keep running in the background.
- Bluetooth needs Chrome on Android, or Chrome or Edge on a computer. It doesn't work on iPhone or in Firefox.
- In some browsers you need to tap **Reconnect** and pick the tag again after reopening the app.
- The alarm plays at media volume.
- Phone GPS works offline, but the first fix can take 30 seconds or more. On a computer, location usually needs internet, so place the pin on the map instead.
- A map area only shows offline if you've viewed it once while online.
- Data lives in this browser on this device. Clearing the site's data erases it, and there's no sync or backup yet.

## Development

There's no build step and there are no npm dependencies. Needs Node 20 or newer.

```sh
npm start        # serve at http://localhost:8080
npm test         # unit tests: distance, bearing, compass heading, formatting
npm run check    # sw.js precaches exactly the app's files
npm run smoke    # end-to-end test in headless Edge/Chrome: fake Bluetooth tag, emulated GPS and compass, offline reload
npm run icons    # redraw icons/*.png
```

**After changing any app file, bump `VERSION` in `sw.js`.** Otherwise installed copies keep the old files. A new file also needs adding to `PRECACHE` in `sw.js`, and `npm run check` catches a missing one.

| Path | What it is |
| --- | --- |
| `index.html`, `css/app.css` | Page shell and styles (light and dark) |
| `js/app.js` | Screens, routing, sheets and alarms |
| `js/ble.js` | Web Bluetooth: linking, monitoring, reconnecting, ringing |
| `js/geo.js`, `js/geo-math.js` | GPS, compass heading, distance and bearing math |
| `js/map.js` | Leaflet map, loaded when the Map tab first opens |
| `js/db.js` | IndexedDB storage for items and their history |
| `js/alarm.js` | Siren, vibration, notifications, keeping the screen on |
| `sw.js` | Service worker: offline caching of the app and viewed map tiles |
| `tools/` | Dev server, icon generator, precache check, smoke test |

## Credits

Map by [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause), with tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
