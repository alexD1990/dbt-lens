# Changelog

## 0.3.0 (preview)

First release on the VS Code Marketplace.

- **New name: NodeViz** (was dbt Lens / dbt Flow), with a new icon and logo. Settings keep their `dbtFlow.*` names, so existing setups keep working.
- **Run dbt from the canvas.** Right-click a box for `dbt build`, `run`, `test` or `compile` on that model and everything upstream; the ▶ button runs a command on the whole project. Commands go to a normal terminal called *NodeViz*. New settings `dbtFlow.dbt.executable`, `dbtFlow.dbt.target` and `dbtFlow.dbt.envFile`.
- **Trace a column.** With [DAGtracer](https://github.com/alexD1990/DAGtracer) installed, *Trace column…* shows which models still have a column and marks where it is dropped. Also from the right-click menu in a SQL file.
- **Sync with files** reads the whole project again and lays it out from scratch (one undo step).
- **Remove from canvas** takes any box off the canvas without touching its file; *Show removed boxes* brings them back.
- **Rename** a model on the canvas or in Explorer, and NodeViz offers to update every `ref()` to it. A red box (ref to a missing model) can be pointed at another model, or its refs removed.
- **Flow direction:** left to right or top to bottom.
- New look: glowing connections, icon tiles, minimap and a floating tool bar. The box for the file you have open lights up.
- Removed the lock mode: every box moves freely, and moving never changes SQL.

## 0.2.0

- The canvas is now an editor tab that opens to the right of your code on startup, instead of a side bar view that replaced Explorer.
- New: **dbt Flow** button in the status bar and a canvas button in the title bar of `.sql` files to reopen it.
- New setting `dbtFlow.openOnStartup`.

## 0.1.0

First version.

- Canvas of models, sources, seeds and snapshots from `ref()` / `source()`, live on save.
- Finds `model-paths` from `dbt_project.yml`, forgiving about `model` vs `models` and case.
- Colour per folder under the models folder.
- Create boxes, connect them, create one or all `.sql` files with import CTEs.
- Connecting onto an existing model adds the `ref()` at the top of its file.
- Locked positions for models with files; unlock, move, put back.
- Undo / redo for every canvas change, including file edits.
- Lineage highlight, search, tidy-up layout, fit to view.
- Activity bar view, or open as an editor tab.
