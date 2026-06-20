# astrospot

A simple personal web app for planning astrophotography outings. Find dark locations, check moon phases, and get a weather snapshot — all on one map.

## Features

- **Satellite map** with borders and place labels
- **Search** any location by name (powered by Nominatim)
- **Pin a spot** to see:
  - Moon phase and illumination tonight
  - Light pollution / Bortle class
  - Current cloud cover and weather
  - Nearest ClearDarkSky site with distance and a line on the map
  - Links to ClearOutside and AccuWeather forecasts
- **7-day moon strip** along the bottom — darker days are better for imaging
- **5,700+ ClearDarkSky sites** toggled on the map by default

## Stack

No build step, no API keys. Pure HTML/CSS/JS using:

- [MapLibre GL JS](https://maplibre.org/) — map rendering
- [SunCalc](https://github.com/mourner/suncalc) — moon phase calculations
- [Open-Meteo](https://open-meteo.com/) — weather and cloud cover
- [Nominatim](https://nominatim.org/) — geocoding
- Esri World Imagery + Reference tiles — satellite basemap

## Running locally

```bash
python3 -m http.server
```

Then open `http://localhost:8000`.
