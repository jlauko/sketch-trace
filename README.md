# Sketch Trace

Turns a reference photo into something easy to sketch from, and floats it over
your phone's camera so you can trace it onto paper or canvas.

Plain HTML/CSS/JS, no build step, no dependencies. Photos never leave the
device — they are processed in the browser and kept in its local storage.

## Run it on this computer

```bash
python -m http.server 8765
```

Then open http://localhost:8765.

## Put it on a phone

The camera only works over https, so the folder has to be hosted somewhere
(GitHub Pages, Netlify, Cloudflare Pages — any static host). Open the hosted
address on the phone once while online, then use "Add to Home Screen". After
that it opens with no signal, and the last photo you loaded is still there.

When you change any file, bump `VERSION` in `sw.js` so installed copies update.

## Files

- `index.html`, `styles.css`, `app.js` — the whole app
- `sw.js`, `manifest.webmanifest`, `icons/` — offline + home-screen install
