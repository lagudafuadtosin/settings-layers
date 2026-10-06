# Settings Layers

Keep your team's VS Code settings in git. Keep your own settings on top. Use different settings on Windows, macOS and Linux.

Settings Layers builds `.vscode/settings.json` from two files:

| File | What goes in it | In git? |
|---|---|---|
| `.vscode/settings.shared.json` | Settings for everyone on the project | Yes |
| `.vscode/settings.local.json` | Your own settings. These win. | No |
| `.vscode/settings.json` | Built for you. VS Code reads this one. | No |

Change either file and `settings.json` is rebuilt at once.

## Get started

1. Open your project.
2. Run **Settings Layers: Set Up Layers** from the Command Palette.
3. Choose where your current settings go: shared with the team, or only for you.
4. Say yes to the `.gitignore` lines.

That is all. Commit `settings.shared.json`.

## The Settings editor still works

Change a setting in the Settings editor (or type in `settings.json`) and Settings Layers saves it to `settings.local.json`. Your team's file is never touched. Reset a setting and it comes out of your file again.

## Settings for each operating system

Add `@windows`, `@macos` or `@linux` to any layer. Only the block for your system is used.

```jsonc
{
    "editor.fontSize": 14,
    "@windows": {
        "terminal.integrated.defaultProfile.windows": "Git Bash"
    },
    "@macos": {
        "editor.fontSize": 15
    }
}
```

### In your user settings too

Settings Sync copies the same user settings to every machine. Put the ones that differ in `settingsLayers.platform`:

```jsonc
"settingsLayers.platform": {
    "windows": { "editor.fontSize": 13 },
    "macos": { "editor.fontSize": 15 }
}
```

This one setting syncs everywhere. Each machine uses its own block. Settings Layers adds every key named here to `settingsSync.ignoredSettings`, so your machines stop overwriting each other.

## Start from another file

`@extends` applies other files first. Use a path, or a file inside an npm package.

```jsonc
{
    "@extends": ["../../config/vscode-base.json", "@acme/vscode-settings/strict.json"],
    "editor.tabSize": 2
}
```

Extended files can extend too. Settings Layers watches them all.

## Where does a setting come from?

- Hover over a setting in any of the files. It tells you which layer sets it, and if another layer wins.
- Run **Settings Layers: Where Does Each Setting Come From?** for the full list. Pick one to jump to it.
- Click **Layers** in the status bar.

## How layers merge

In this order, the last one wins:

1. Files from `@extends` in `settings.shared.json`
2. `settings.shared.json`
3. Its block for your system
4. Files from `@extends` in `settings.local.json`
5. `settings.local.json`
6. Its block for your system

Objects such as `files.exclude` or `"[python]"` merge key by key. Lists and everything else are replaced.

## Also

- Setting names autocomplete in both files, inside the system blocks too.
- A broken file shows in the Problems panel. The rest still builds.
- Works with multi-root workspaces. Each folder has its own layers.
- Runs only in trusted folders.

## Moving from Workspace Config+

It uses the same two file names. Install Settings Layers, turn the other one off, and your files work as they are.

## Commands

| Command | What it does |
|---|---|
| Settings Layers: Set Up Layers | Creates the files and offers the `.gitignore` lines |
| Settings Layers: Where Does Each Setting Come From? | Lists every setting and its layer |
| Settings Layers: Open Shared Settings | Opens `settings.shared.json` |
| Settings Layers: Open My Settings | Opens `settings.local.json` |
| Settings Layers: Rebuild settings.json | Builds it again |

## Why

People have asked VS Code for this for years:

- [#15909](https://github.com/microsoft/vscode/issues/15909) Add ability to extend from other settings files
- [#5595](https://github.com/microsoft/vscode/issues/5595) Allow to scope settings by platform
- [#40233](https://github.com/microsoft/vscode/issues/40233) Local workspace settings

## Licence

MIT
