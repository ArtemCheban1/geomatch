# Історичні місця (довідкові шари)

`index.json` — список вбудованих шарів. Кожен шар — файл GeoJSON (`FeatureCollection` з точками,
координати WGS84 `[lng, lat]`). Застосунок вантажить файл лише коли шар увімкнено.

Очікувані властивості (будь-які інші теж показуються в картці об'єкта):

| поле | приклад |
|------|---------|
| `name` | Cetatea de Scaun a Sucevei |
| `cod` | Код RAN, напр. 146272.01 |
| `judet`, `localitate`, `comuna` | Suceava, Suceava, Suceava |
| `tip` | cetate / așezare / necropolă |
| `epoca` | Epoca medievală |
| `url` | посилання на запис у ran.cimec.ro |

Файли `ran-suceava.geojson` і `ran-botosani.geojson` ще треба згенерувати з бази
[Repertoriul Arheologic Național](https://ran.cimec.ro/) (джерело: INP / cIMeC).
