# ClipLib rich presence art

Pictures ClipLib's Discord status shows for games it reads live details from: the map, level, biome
or character you're on. Served through jsDelivr, pinned to a tag:

```
https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@<tag>/<game>/<key>.webp
```

`index.json` lists every game and image, with the names each game writes to its logs as `aliases`.
`credits.json` has the source page of every image. `preview.html` shows the whole pack.

## Building

Recipes in `build/recipes/` say where each picture comes from (a wiki page, a wiki file, a Steam
screenshot or a direct url) and how to crop it. Nothing is picked by hand beyond the recipe.
Items are 512 px squares; `banner: true` makes a 1536x512 banner for ClipLib's settings page and
`fit: "contain"` pads a logo instead of cropping it.

```
node build/build.mjs                     # everything
node build/build.mjs repo peak           # some games
node build/build.mjs discover https://peak.wiki.gg Category:Biomes
```

Needs Node 20+ and an ffmpeg with libwebp (`FFMPEG=path/to/ffmpeg`). A workflow rebuilds monthly
and opens a pull request when something changed.

## Rights

The images belong to their games' publishers and come from the community wikis and store pages
named in `credits.json`. They're used here, unchanged apart from cropping, to show which game and
place a player is in. If you hold the rights to one and want it gone, open an issue and it will be
removed. The build scripts are MIT.
