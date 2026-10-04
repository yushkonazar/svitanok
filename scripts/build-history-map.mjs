// Offline Natural Earth map. D3 clips spherical rings at the antimeridian;
// drawing raw lon/lat rings connects Alaska/Asia across the entire viewport.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../web/app/package.json', import.meta.url));
const { geoEquirectangular, geoPath } = await import(pathToFileURL(require.resolve('d3-geo')).href);
const { feature } = require('topojson-client');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/build-history-map.mjs world-land.json');
const topology = JSON.parse(await readFile(source, 'utf8'));
const projection = geoEquirectangular()
  .translate([180, 90])
  .scale(180 / Math.PI)
  .precision(0.1);
const land = geoPath(projection).digits(2)(feature(topology, topology.objects.land));
if (!land) throw new Error('Empty map geometry');
const target = fileURLToPath(new URL('../web/app/src/lib/worldLand.ts', import.meta.url));
await writeFile(
  target,
  '// Natural Earth 110m, public domain. D3 antimeridian clipping. 360 × 180.\nexport const WORLD_LAND = ' +
    JSON.stringify(land) +
    ';\n',
);
console.log('Generated antimeridian-safe map (' + land.length + ' SVG bytes).');
