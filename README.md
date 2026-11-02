# Portfolio · Oumayma El Moussaoui

Personal portfolio site: data scientist working with image and measurement data.

Plain HTML/CSS/JS, no build step.

- `index.html`: page content
- `assets/style.css`: styles (light/dark theme)
- `assets/main.js`: theme toggle, animated crack-network background, scroll effects
- `assets/crack-demo.js`: live in-browser crack-analysis demo (top-hat, Otsu, skeletonization, measurements, F1 vs ground truth)

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publish with GitHub Pages

Repository **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
The site will be served at `https://elmoussaouioumayma.github.io/Portfolio/`.
