# Changelog

## 1.0.0

- Builds `.vscode/settings.json` from `settings.shared.json` and `settings.local.json`
- Changes made in the Settings editor are saved to `settings.local.json`
- `@windows`, `@macos` and `@linux` blocks in any layer
- `settingsLayers.platform` for user settings per system, kept out of Settings Sync
- `@extends` for other files and npm packages
- Hover and a command that show where each setting comes from
- Setting names autocomplete in the layer files
- Problems panel errors for broken files
- Multi-root workspaces
