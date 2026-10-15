# bb-plugins

Plugins for [bb](https://getbb.app). Each directory is one plugin with its own
`package.json`, README, and tests.

| Plugin | What it does |
| --- | --- |
| [Library](bb-plugin-library) | Save diagrams, call flows, explanations, and design docs from any thread, then search them in one place. |
| [PR Board](bb-plugin-pr-board) | A kanban board of open GitHub PRs with agent review threads and a side-by-side diff review page. |
| [Thread Meter](bb-plugin-thread-meter) | Context, token cost, and plan usage beside the composer's model picker. |
| [Thread Router](bb-plugin-thread-router) | Files new threads into the best-matching sidebar section, or `other` when none fits. |
| [Trees](bb-plugin-trees) | Plan work as a dependency graph of atomic tasks, and pass each finished task's context down to the ones that depend on it. Needs a bb built from the rchen-cape/bb fork. |

## Install

From GitHub, one plugin at a time, by its name in [.bb/plugins.json](.bb/plugins.json):

```
bb plugin install git:https://github.com/meisbobzheng/bb-plugins.git@main --plugin library
```

From a local checkout:

```
cd bb-plugin-library
npm install
bb plugin install .
```

## Develop

Every plugin has `typecheck`, `build`, and `check` scripts, and `test` when it
has tests. `check` runs them all:

```
npm run check
```

`bb plugin dev` in a plugin directory rebuilds and reloads it on every save.
