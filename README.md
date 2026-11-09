# dbt Flow

A VS Code canvas for dbt models. It draws how your existing models connect, and lets you sketch new ones as boxes that become `.sql` files.

## What it does

**Reads your project.** It finds `dbt_project.yml`, reads `model-paths` (and finds the folder even if it is called `model` instead of `models`), and draws every model from its `ref()` and `source()` calls. Seeds, snapshots and Python models are included. A `ref()` to a model that does not exist shows as a red box. The canvas updates when you save a file; dbt does not need to run.

**Sync with files.** The top button in the tool bar on the left (two arrows in a circle), or *Sync with files* on the canvas menu, reads every file again, puts every model, source, seed and snapshot on the canvas, including boxes you removed, and lays them out left to right. Use it to get a clean picture of an existing project. Ctrl+Z undoes it.

**Left to right or top to bottom.** The flow button in the tool bar (or *Flow top to bottom* on the canvas menu) switches between left to right and top to bottom, with downstream models below. The choice is saved per project; Ctrl+Z switches back.

**Colours by folder.** Each folder under `models/` gets its own colour. `staging`, `intermediate` and `marts` get their usual blue, violet and amber; other folders take the next colour in the palette. Sources are green pills on the left.

**Sketch new models.** Right-click the canvas and choose *Create new box*. Name it, pick a folder (suggested from the prefix: `stg_` goes to staging, `fct_`/`dim_` to marts), then drag from the dot on the right of one box onto another to connect them. Boxes without a file are dashed.

**Create the files.** Right-click a dashed box and choose *Create file*, or right-click the canvas and choose *Create all files*. Each file gets one import CTE per upstream box:

```sql
with

stg_orders as (
    select * from {{ ref('stg_orders') }}
),

stg_customers as (
    select * from {{ ref('stg_customers') }}
)

select * from stg_orders
```

**Connect existing models.** Dragging a connection onto a model that already has a file adds the `ref()` as an import CTE at the top of that file, after any `{{ config() }}` block. You are asked first; turn that off with `dbtFlow.confirmFileEdits`.

**Move boxes freely.** Drag any box anywhere; Ctrl+Z puts it back. Moving a box never changes any SQL.

**Rename without breaking refs.** Right-click a model and choose *Rename…*, or rename the file in Explorer: the box keeps its place and dbt Flow offers to update every `ref()` to it. A red box is a `ref()` to a model that has no `.sql` file; right-click it to point the refs at another model.

**Removing a box never deletes a file.** A box without a file is deleted. Any other box is only taken off the canvas (right-click → *Remove from canvas*, or Delete); its file stays. *Show removed boxes* on the canvas menu brings them back. If you delete a `.sql` file that other models still use, its box turns red, and you can remove that red box the same way.

**Undo everything.** Ctrl+Z / Ctrl+Shift+Z in the canvas undo and redo moves, boxes, connections and created files, including the file edits. If you edited a file by hand after dbt Flow changed it, undo stops and tells you instead of overwriting your work.

**Lineage.** Click a box to highlight everything upstream and downstream. The box for the file open in the editor is underlined.

## Where it lives

The canvas is an editor tab. When you open a dbt project it opens by itself to the right of your code, so Explorer, the file, the canvas and the chat side bar are all visible at once. Drag the divider to resize it, or drag the tab to another group.

If you close it, bring it back with the **dbt Flow** button in the status bar, the canvas button in the title bar of any `.sql` file, or *dbt Flow: Open Canvas* in the command palette. Turn off the automatic opening with `dbtFlow.openOnStartup`.

## The `.dbtflow.json` file

Box positions, boxes without files, their connections and the boxes you removed from the canvas are kept in `.dbtflow.json` next to `dbt_project.yml`. Commit it if your team should see the same layout and sketches; add it to `.gitignore` if not. It is only written after you change something on the canvas.

## Shortcuts

| Key | Action |
| --- | --- |
| Right-click | Menu for the box, connection or canvas under the pointer |
| Drag right-hand dot onto a box | Connect |
| Click box | Highlight lineage |
| Double-click box | Open file (or rename a box without a file) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Delete | Delete a box without a file, or take any other box off the canvas (files are kept) |
| F | Fit to view |
| Ctrl+F, Enter | Find a model and jump to it |
| Scroll / drag background | Zoom / pan |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `dbtFlow.openOnStartup` | `true` | Open the canvas next to your code when a dbt project opens. |
| `dbtFlow.projectPath` | empty | Folder holding `dbt_project.yml`. Empty means find it automatically. |
| `dbtFlow.confirmFileEdits` | `true` | Ask before adding a `ref()` to an existing file. |
| `dbtFlow.openCreatedFile` | `true` | Open the new file after *Create file*. |

## Development

No build step and no dependencies: plain JavaScript.

```
npm test                       # model + extension tests (node --test)
code --extensionDevelopmentPath=.   # or F5 with the included launch config
```

`src/` holds the logic (parsing, layout, SQL edits, undo) with no VS Code imports, so it is tested directly. `extension.js` wires it to VS Code. `media/` is the canvas.
