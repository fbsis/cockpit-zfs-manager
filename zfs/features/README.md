# Feature modules

New, self-contained UI features should live in this directory instead of
growing `zfs.js` and `zfs.css`.

- Keep feature-specific behavior in a named JavaScript file.
- Keep feature-specific presentation in a matching CSS file when needed.
- Load dependencies before `zfs.js` in `index.html`.
- Leave only the minimum integration calls and shared behavior in `zfs.js`.
- Feature scripts are classic browser scripts, not ES modules, to remain
  compatible with the Cockpit versions supported by this project.

Current modules:

- `replication.js` / `replication.css`: replication wizard, retention plans,
  presets, persistent systemd-backed run-now jobs, validation, status, and logs.
- `scrub-schedule.js` / `scrub-schedule.css`: per-pool scheduled scrub editor,
  timer status, next-run preview, conflict detection, and run-now controls.
- `../helpers/manage-scrub-schedule`: validates and atomically manages the
  systemd service, timer, and persistent schedule metadata for each pool.
- `../helpers/run-replication-job`: serialized background replication runner. It
  restores the znapzend scheduler on exit, verifies the new source and
  destination snapshots, and stores reload-safe job state under
  `/var/lib/cockpit-zfs-manager/replication-jobs`.
- `filesystem-columns.js`: optional filesystem table column controls.
- `filesystem-usage.js`: filesystem usage calculation and rendering.
- `filesystem-table.css`: hierarchy, optional columns, and usage presentation.
