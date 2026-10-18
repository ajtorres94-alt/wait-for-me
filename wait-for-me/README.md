# Wait For Me!

Book someone to hold your spot in line, or get paid to wait.

This is the clickable prototype packaged as an installable web app. It uses sample data, nothing is saved between visits, and no payments are processed.

## Files

| File | What it does |
| --- | --- |
| `server.js` | Tiny Node server with no dependencies. Serves the `public` folder on Railway's `PORT`. |
| `package.json` | Tells Railway to run `npm start`. |
| `public/index.html` | The app. |
| `public/manifest.webmanifest` | App name, icon, and colors for "Add to Home Screen". |
| `public/sw.js` | Makes the app installable and lets it open without a connection. |
| `public/icons/` | App icons. |

## Run it on your computer (optional)

Needs Node 18 or newer.

```
npm start
```

Then open http://localhost:3000.

## Deploy to Railway

1. Create a new GitHub repo named `wait-for-me` and upload everything in this folder to it.
2. In Railway, click **New Project → Deploy from GitHub repo** and pick `wait-for-me`.
3. Railway detects Node and runs `npm start`. Wait for the deploy to show **Active**.
4. Open the service, go to **Settings → Networking**, and click **Generate Domain**.
5. Open that link on your phone.

## Install it on your phone

- **iPhone (Safari):** tap Share, then **Add to Home Screen**.
- **Android (Chrome):** tap the ⋮ menu, then **Install app** or **Add to Home screen**.

It opens full screen with its own icon, like a native app.

## Updating

Change files, commit, and push to GitHub. Railway redeploys automatically, and the app on your phone picks up the new version the next time it opens.
