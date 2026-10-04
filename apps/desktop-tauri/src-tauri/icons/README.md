# Icons

The committed `icon.svg` is a placeholder. Tauri's bundler expects raster/ICO
variants listed in `tauri.conf.json` → `bundle.icon`. Generate them once with:

```powershell
# From apps/desktop-tauri/ (after pnpm i --ignore-workspace)
pnpm tauri icon src-tauri/icons/icon.svg
```

This produces `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
`icon.ico`, and the Windows Store square tiles. All generated rasters are
gitignored — only the source SVG is checked in.

For the installer's file-association icon (`.kbnote`), the same `icon.ico` is
reused (see `tauri.conf.json` → `bundle.windows.fileAssociations[0].icon`).
