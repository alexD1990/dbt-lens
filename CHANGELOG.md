# Changelog

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
