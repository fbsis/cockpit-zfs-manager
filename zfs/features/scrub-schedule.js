//#region Scheduled ZFS scrubs

const ZFSScrubSchedule = (() => {
    const helperCandidates = [
        "/usr/share/cockpit/zfs/helpers/manage-scrub-schedule",
        "/usr/local/share/cockpit/zfs/helpers/manage-scrub-schedule",
    ];

    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        })[character]);
    }

    function hash(value) {
        let result = 2166136261;
        for (let index = 0; index < value.length; index++) {
            result ^= value.charCodeAt(index);
            result = Math.imul(result, 16777619);
        }
        return (result >>> 0).toString(16).padStart(8, "0");
    }

    function scheduleId(poolName) {
        let slug = String(poolName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "pool";
        return slug + "-" + hash(String(poolName || ""));
    }

    function statePath(poolName) {
        return "/etc/cockpit/zfs/scrub-schedules/" + scheduleId(poolName) + ".conf";
    }

    function unitName(poolName, suffix) {
        return "cockpit-zfs-scrub-" + scheduleId(poolName) + "." + suffix;
    }

    function parseProperties(output) {
        return String(output || "").split("\n").reduce((properties, line) => {
            let separator = line.indexOf("=");
            if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1);
            return properties;
        }, {});
    }

    function errorText(error) {
        return [error && error.message, error && error.problem, error && error.exit_status, String(error || "")]
            .filter(Boolean).join(" ").replace(/^Error:\s*/i, "").trim();
    }

    async function findHelper() {
        for (const candidate of helperCandidates) {
            try {
                let output = await cockpit.spawn(["/bin/sh", "-c", "test -x \"$1\" && printf '%s' \"$1\"", "cockpit-zfs-manager", candidate], { err: "out", superuser: "try" });
                if (output.trim()) return output.trim();
            } catch (error) {
                // Continue checking package-owned paths.
            }
        }
        return null;
    }

    async function readConfiguration(poolName) {
        try {
            let output = await cockpit.spawn([
                "/bin/sh", "-c", "if [ -f \"$1\" ]; then exec /usr/bin/cat \"$1\"; else printf '%s' '__cockpit_zfs_no_schedule__'; fi",
                "cockpit-zfs-manager", statePath(poolName),
            ], { err: "out", superuser: "try" });
            if (output === "__cockpit_zfs_no_schedule__") return null;
            let configuration = parseProperties(output);
            if (configuration.pool !== poolName) throw new Error("The stored schedule belongs to a different pool.");
            return configuration;
        } catch (error) {
            let details = errorText(error).toLowerCase();
            if (details.includes("no such file") || details.includes("not found")) return null;
            throw error;
        }
    }

    async function readStatus(poolName, configuration) {
        let status = {
            configured: !!configuration,
            active: false,
            enabled: configuration && configuration.enabled === "1",
            next: "",
            last: "",
            error: "",
        };
        if (!configuration) return status;

        try {
            let output = await cockpit.spawn([
                "/usr/bin/systemctl", "show", unitName(poolName, "timer"),
                "--property=ActiveState", "--property=UnitFileState",
                "--property=NextElapseUSecRealtime", "--property=LastTriggerUSec",
                "--no-pager",
            ], { err: "out", superuser: "try" });
            let properties = parseProperties(output);
            status.active = properties.ActiveState === "active" || properties.ActiveState === "activating";
            status.next = properties.NextElapseUSecRealtime && properties.NextElapseUSecRealtime !== "n/a" ? properties.NextElapseUSecRealtime : "";
            status.last = properties.LastTriggerUSec && properties.LastTriggerUSec !== "n/a" ? properties.LastTriggerUSec : "";
            if (status.enabled && !status.active) status.error = "The schedule is enabled, but its systemd timer is not active.";
        } catch (error) {
            status.error = "The saved schedule exists, but its systemd timer could not be read.";
        }

        try {
            let output = await cockpit.spawn([
                "/usr/bin/systemctl", "show", unitName(poolName, "service"),
                "--property=Result", "--property=ExecMainStatus", "--no-pager",
            ], { err: "out", superuser: "try" });
            let properties = parseProperties(output);
            if (properties.Result === "failed") {
                status.error = "The last scheduled scrub could not be started" + (properties.ExecMainStatus ? " (exit " + properties.ExecMainStatus + ")" : "") + ".";
            }
        } catch (error) {
            // A schedule that has never triggered may not have service runtime state yet.
        }
        return status;
    }

    async function load(poolName) {
        let configuration = await readConfiguration(poolName);
        return { configuration, status: await readStatus(poolName, configuration) };
    }

    function calendarFor(values) {
        let hour = String(Number(values.hour) || 0).padStart(2, "0");
        let minute = String(Number(values.minute) || 0).padStart(2, "0");
        if (values.frequency === "daily") return "*-*-* " + hour + ":" + minute + ":00";
        if (values.frequency === "monthly") return "*-*-" + String(Number(values.dayValue) || 1).padStart(2, "0") + " " + hour + ":" + minute + ":00";
        return values.dayValue + " *-*-* " + hour + ":" + minute + ":00";
    }

    function formValues(poolId) {
        let frequency = $("#select-scrub-schedule-frequency-" + poolId).val();
        let weekdays = $("#scrub-schedule-weekdays-" + poolId + " input:checked").map(function () { return $(this).val(); }).get();
        return {
            enabled: $("#switch-scrub-schedule-enabled-" + poolId + " input").prop("checked"),
            frequency,
            dayValue: frequency === "weekly" ? weekdays.join(",") : (frequency === "monthly" ? $("#input-scrub-schedule-month-day-" + poolId).val() : "daily"),
            hour: $("#input-scrub-schedule-hour-" + poolId).val(),
            minute: $("#input-scrub-schedule-minute-" + poolId).val(),
        };
    }

    function validate(values) {
        if (!["daily", "weekly", "monthly"].includes(values.frequency)) return "Choose a valid frequency.";
        if (values.frequency === "weekly" && !values.dayValue) return "Select at least one weekday.";
        if (values.frequency === "monthly" && (Number(values.dayValue) < 1 || Number(values.dayValue) > 31)) return "Day of month must be between 1 and 31.";
        if (!/^\d+$/.test(String(values.hour)) || Number(values.hour) < 0 || Number(values.hour) > 23) return "Hour must be between 0 and 23.";
        if (!/^\d+$/.test(String(values.minute)) || Number(values.minute) < 0 || Number(values.minute) > 59) return "Minute must be between 0 and 59.";
        return "";
    }

    async function previewCalendar(poolId) {
        let values = formValues(poolId);
        let validation = validate(values);
        let $preview = $("#scrub-schedule-preview-" + poolId);
        if (validation) {
            $preview.html('<span class="text-danger">' + escapeHtml(validation) + "</span>");
            return;
        }
        let calendar = calendarFor(values);
        $preview.html("<code>" + escapeHtml(calendar) + "</code><small>Calculating the next run on the server...</small>");
        try {
            let output = await cockpit.spawn(["/usr/bin/systemd-analyze", "calendar", "--iterations=1", calendar], { err: "out", superuser: "try" });
            let nextLine = String(output).split("\n").find(line => /^\s*Next elapse:/i.test(line));
            let next = nextLine ? nextLine.replace(/^\s*Next elapse:\s*/i, "") : "Calculated when the timer is applied";
            $preview.html("<code>" + escapeHtml(calendar) + "</code><small>Next: " + escapeHtml(next) + "</small>");
        } catch (error) {
            $preview.html("<code>" + escapeHtml(calendar) + "</code><small>Next run is calculated by systemd when applied.</small>");
        }
    }

    async function detectExistingSchedulers(poolName) {
        let warnings = [];
        let escapedPool = poolName;
        try {
            escapedPool = (await cockpit.spawn(["/usr/bin/systemd-escape", poolName], { err: "out", superuser: "try" })).trim() || poolName;
        } catch (error) {
            // Simple pool names do not need systemd escaping.
        }

        for (const cadence of ["weekly", "monthly"]) {
            try {
                await cockpit.spawn(["/usr/bin/systemctl", "is-enabled", "zfs-scrub-" + cadence + "@" + escapedPool + ".timer"], { err: "out", superuser: "try" });
                warnings.push("OpenZFS " + cadence + " timer is already enabled for this pool.");
            } catch (error) {
                // The distribution timer is not enabled.
            }
        }

        try {
            let cron = await cockpit.spawn(["/usr/bin/cat", "/etc/cron.d/zfsutils-linux"], { err: "out", superuser: "try" });
            if (String(cron).split("\n").some(line => line.trim() && !line.trim().startsWith("#") && /scrub/i.test(line))) {
                warnings.push("The zfsutils-linux cron file also appears to schedule scrubs.");
            }
        } catch (error) {
            // This distribution does not use the zfsutils-linux cron scheduler.
        }
        return warnings;
    }

    function frequencyLabel(configuration) {
        if (!configuration) return "Not configured";
        let time = String(configuration.hour || "0").padStart(2, "0") + ":" + String(configuration.minute || "0").padStart(2, "0");
        if (configuration.frequency === "daily") return "Daily at " + time;
        if (configuration.frequency === "monthly") return "Monthly on day " + configuration.day_value + " at " + time;
        return "Weekly on " + String(configuration.day_value || "").split(",").join(", ") + " at " + time;
    }

    function statusMarkup(configuration, status) {
        if (!configuration) {
            return '<div class="scrub-schedule-ct-empty"><span class="glyphicon glyphicon-time" aria-hidden="true"></span><div><strong>No scheduled scrub</strong><small>Create a schedule for this pool below.</small></div></div>';
        }
        let stateClass = status.error ? "danger" : (configuration.enabled === "1" ? "success" : "info");
        let icon = status.error ? "glyphicon-exclamation-sign" : (configuration.enabled === "1" ? "glyphicon-ok-sign" : "glyphicon-pause");
        let title = status.error ? "Schedule needs attention" : (configuration.enabled === "1" ? "Schedule active" : "Schedule disabled");
        return '<div class="alert alert-' + stateClass + ' scrub-schedule-ct-status">' +
            '<span class="glyphicon ' + icon + '" aria-hidden="true"></span><div><strong>' + title + '</strong>' +
            '<small>' + escapeHtml(frequencyLabel(configuration)) + '</small>' +
            (status.next ? '<small><strong>Next:</strong> ' + escapeHtml(status.next) + '</small>' : "") +
            (status.last ? '<small><strong>Last trigger:</strong> ' + escapeHtml(status.last) + '</small>' : "") +
            (status.error ? '<small class="text-danger">' + escapeHtml(status.error) + '</small>' : "") +
            "</div></div>";
    }

    function renderForm(pool, configuration, status) {
        let frequency = configuration && configuration.frequency || "weekly";
        let selectedDays = new Set(String(configuration && configuration.day_value || "Sun").split(","));
        let hour = String(configuration && configuration.hour != null ? configuration.hour : "0").padStart(2, "0");
        let minute = String(configuration && configuration.minute != null ? configuration.minute : "0").padStart(2, "0");
        let monthDay = frequency === "monthly" ? configuration.day_value : "1";
        let enabled = !configuration || configuration.enabled === "1";
        let weekdays = [
            ["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"],
            ["Fri", "Friday"], ["Sat", "Saturday"], ["Sun", "Sunday"],
        ].map(day => '<label class="checkbox-inline"><input type="checkbox" value="' + day[0] + '"' + (selectedDays.has(day[0]) ? " checked" : "") + '> ' + day[1].slice(0, 3) + "</label>").join("");

        return `
            <div class="modal-dialog scrub-schedule-ct-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <button type="button" class="close" data-dismiss="modal" aria-label="Close"><span aria-hidden="true">&times;</span></button>
                        <h4 class="modal-title"><span class="glyphicon glyphicon-time" aria-hidden="true"></span> Scheduled Scrub</h4>
                    </div>
                    <div class="modal-body">
                        <div id="scrub-schedule-alert-${pool.id}"></div>
                        <div id="scrub-schedule-status-${pool.id}">${statusMarkup(configuration, status)}</div>
                        <form class="ct-form scrub-schedule-ct-form">
                            <label class="control-label">Pool</label>
                            <div><strong>${escapeHtml(pool.name)}</strong></div>
                            <label class="control-label">Enabled</label>
                            <div><label id="switch-scrub-schedule-enabled-${pool.id}" class="onoff-ct privileged-modal"><input type="checkbox"${enabled ? " checked" : ""}><span class="switch-toggle"></span></label><span>Run this schedule automatically</span></div>
                            <label class="control-label" for="select-scrub-schedule-frequency-${pool.id}">Frequency</label>
                            <select id="select-scrub-schedule-frequency-${pool.id}" class="form-control privileged-modal">
                                <option value="daily"${frequency === "daily" ? " selected" : ""}>Daily</option>
                                <option value="weekly"${frequency === "weekly" ? " selected" : ""}>Weekly</option>
                                <option value="monthly"${frequency === "monthly" ? " selected" : ""}>Monthly</option>
                            </select>
                            <label class="control-label scrub-schedule-weekly-${pool.id}">Days of week</label>
                            <div id="scrub-schedule-weekdays-${pool.id}" class="scrub-schedule-ct-weekdays scrub-schedule-weekly-${pool.id}">${weekdays}</div>
                            <label class="control-label scrub-schedule-monthly-${pool.id}" for="input-scrub-schedule-month-day-${pool.id}">Day of month</label>
                            <div class="scrub-schedule-monthly-${pool.id}"><input id="input-scrub-schedule-month-day-${pool.id}" class="form-control privileged-modal" min="1" max="31" type="number" value="${escapeHtml(monthDay)}"><small>Dates that do not exist in a month are skipped.</small></div>
                            <label class="control-label">Time</label>
                            <div class="scrub-schedule-ct-time">
                                <input id="input-scrub-schedule-hour-${pool.id}" aria-label="Hour" class="form-control privileged-modal" inputmode="numeric" maxlength="2" pattern="[0-9]*" type="text" value="${escapeHtml(hour)}">
                                <span>:</span>
                                <input id="input-scrub-schedule-minute-${pool.id}" aria-label="Minute" class="form-control privileged-modal" inputmode="numeric" maxlength="2" pattern="[0-9]*" type="text" value="${escapeHtml(minute)}">
                                <span>server local time</span>
                            </div>
                            <label class="control-label">Schedule preview</label>
                            <div id="scrub-schedule-preview-${pool.id}" class="scrub-schedule-ct-preview"></div>
                        </form>
                        <div id="scrub-schedule-conflicts-${pool.id}"></div>
                        <div id="scrub-schedule-delete-confirm-${pool.id}" class="scrub-schedule-ct-delete-confirm hidden">
                            <div class="alert alert-danger">
                                <strong>Delete this scheduled scrub?</strong>
                                <p>This removes only the schedule. It does not delete the pool or its data.</p>
                                <label for="input-scrub-schedule-delete-confirm-${pool.id}">Type <strong>${escapeHtml(pool.name)}</strong> to confirm.</label>
                                <input id="input-scrub-schedule-delete-confirm-${pool.id}" class="form-control" autocomplete="off" type="text">
                                <button id="btn-scrub-schedule-delete-confirm-${pool.id}" class="btn btn-danger" disabled type="button">Delete schedule</button>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer scrub-schedule-ct-footer">
                        <div>
                            <button id="btn-scrub-schedule-delete-${pool.id}" class="btn btn-link text-danger${configuration ? "" : " hidden"}" title="Delete scheduled scrub" type="button"><span class="glyphicon glyphicon-trash" aria-hidden="true"></span><span class="sr-only">Delete scheduled scrub</span></button>
                        </div>
                        <div id="spinner-scrub-schedule-${pool.id}" class="dialog-wait-ct hidden"><div class="spinner spinner-sm"></div><span></span></div>
                        <div class="modal-ct-buttons">
                            <button class="btn btn-default" data-dismiss="modal" type="button">Close</button>
                            <button id="btn-scrub-schedule-run-${pool.id}" class="btn btn-default privileged-modal" type="button">Run now</button>
                            <button id="btn-scrub-schedule-apply-${pool.id}" class="btn btn-primary privileged-modal" type="button">Apply</button>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    function setBusy(poolId, busy, message) {
        $("#spinner-scrub-schedule-" + poolId).toggleClass("hidden", !busy).find("span").text(message || "");
        $("#btn-scrub-schedule-apply-" + poolId + ", #btn-scrub-schedule-run-" + poolId + ", #btn-scrub-schedule-delete-confirm-" + poolId).prop("disabled", busy);
    }

    function showInlineError(poolId, title, detail) {
        $("#scrub-schedule-alert-" + poolId).html('<div class="alert alert-danger"><span class="glyphicon glyphicon-exclamation-sign" aria-hidden="true"></span> <strong>' + escapeHtml(title) + "</strong> " + escapeHtml(detail || "") + "</div>");
    }

    async function refreshBadge(pool) {
        let $badge = $("#scrub-schedule-badge-" + pool.id);
        if (!$badge.length) return;
        try {
            let data = await load(pool.name);
            if (!data.configuration) {
                $badge.empty().addClass("hidden");
                return;
            }
            let error = data.status.error;
            let enabled = data.configuration.enabled === "1";
            let icon = error ? "glyphicon-exclamation-sign" : (enabled ? "glyphicon-time" : "glyphicon-pause");
            let stateClass = error ? "scrub-schedule-ct-badge-error" : (enabled ? "scrub-schedule-ct-badge-active" : "scrub-schedule-ct-badge-disabled");
            let title = error || (enabled ? "Scheduled scrub: " + frequencyLabel(data.configuration) + (data.status.next ? ". Next: " + data.status.next : "") : "Scheduled scrub is disabled");
            $badge.removeClass("hidden").html('<button class="btn btn-link scrub-schedule-ct-badge ' + stateClass + '" title="' + escapeHtml(title) + '" type="button"><span class="glyphicon ' + icon + '" aria-hidden="true"></span><span class="sr-only">' + escapeHtml(title) + "</span></button>");
            $badge.find("button").on("click", () => $("#btn-storagepool-scrub-schedule-" + pool.id).trigger("click"));
        } catch (error) {
            $badge.removeClass("hidden").html('<button class="btn btn-link scrub-schedule-ct-badge scrub-schedule-ct-badge-error" title="Scheduled scrub status could not be read" type="button"><span class="glyphicon glyphicon-exclamation-sign" aria-hidden="true"></span><span class="sr-only">Scheduled scrub status could not be read</span></button>');
        }
    }

    async function bindModal(pool, configuration, status) {
        let $modal = $("#modal-storagepool-scrub-schedule-" + pool.id);
        let previewTimer = null;
        let updateFrequency = () => {
            let frequency = $("#select-scrub-schedule-frequency-" + pool.id).val();
            $(".scrub-schedule-weekly-" + pool.id).toggleClass("hidden", frequency !== "weekly");
            $(".scrub-schedule-monthly-" + pool.id).toggleClass("hidden", frequency !== "monthly");
            clearTimeout(previewTimer);
            previewTimer = setTimeout(() => previewCalendar(pool.id), 180);
        };
        $modal.find("select, input[type=number], .scrub-schedule-ct-time input, #scrub-schedule-weekdays-" + pool.id + " input").on("change input", updateFrequency);
        $modal.one("hidden.bs.modal", () => clearTimeout(previewTimer));
        updateFrequency();

        detectExistingSchedulers(pool.name).then(warnings => {
            if (!warnings.length) return;
            $("#scrub-schedule-conflicts-" + pool.id).html('<div class="alert alert-warning"><span class="glyphicon glyphicon-warning-sign" aria-hidden="true"></span> <strong>Another scrub scheduler was detected.</strong><ul>' + warnings.map(warning => "<li>" + escapeHtml(warning) + "</li>").join("") + "</ul><p>Disable the other scheduler separately to avoid duplicate scrubs.</p></div>");
        });

        $("#btn-scrub-schedule-apply-" + pool.id).on("click", async function () {
            let values = formValues(pool.id);
            let validation = validate(values);
            if (validation) {
                showInlineError(pool.id, "Schedule is not valid.", validation);
                return;
            }
            setBusy(pool.id, true, "Saving scheduled scrub...");
            $("#scrub-schedule-alert-" + pool.id).empty();
            try {
                let helper = await findHelper();
                if (!helper) throw new Error("The scrub schedule helper is not installed. Reinstall or update Cockpit ZFS Manager.");
                await cockpit.spawn([
                    helper, "save", pool.name, scheduleId(pool.name), values.enabled ? "1" : "0",
                    values.frequency, values.dayValue, String(Number(values.hour)), String(Number(values.minute)),
                ], { err: "out", superuser: "require" });
                let refreshed = await load(pool.name);
                configuration = refreshed.configuration;
                status = refreshed.status;
                $("#scrub-schedule-status-" + pool.id).html(statusMarkup(configuration, status));
                $("#btn-scrub-schedule-delete-" + pool.id).removeClass("hidden");
                await refreshBadge(pool);
                FnDisplayAlert({ status: "success", title: values.enabled ? "Scheduled scrub successfully saved" : "Scheduled scrub saved and disabled", description: pool.name, breakword: false }, { name: "scrub-schedule", id: pool.id, timeout: 4 });
            } catch (error) {
                showInlineError(pool.id, "Scheduled scrub could not be saved.", errorText(error));
            } finally {
                setBusy(pool.id, false);
            }
        });

        $("#btn-scrub-schedule-run-" + pool.id).on("click", function () {
            setBusy(pool.id, true, "Starting scrub...");
            let request = FnStoragePoolScrubStart({ name: pool.name, id: pool.id }, { resume: false }, { refresh: true });
            if (request && typeof request.always === "function") request.always(() => setBusy(pool.id, false));
            else Promise.resolve(request).finally(() => setBusy(pool.id, false));
        });

        $("#btn-scrub-schedule-delete-" + pool.id).on("click", function () {
            $("#scrub-schedule-delete-confirm-" + pool.id).removeClass("hidden");
            $("#input-scrub-schedule-delete-confirm-" + pool.id).focus();
        });
        $("#input-scrub-schedule-delete-confirm-" + pool.id).on("input", function () {
            $("#btn-scrub-schedule-delete-confirm-" + pool.id).prop("disabled", $(this).val() !== pool.name);
        });
        $("#btn-scrub-schedule-delete-confirm-" + pool.id).on("click", async function () {
            setBusy(pool.id, true, "Deleting scheduled scrub...");
            try {
                let helper = await findHelper();
                if (!helper) throw new Error("The scrub schedule helper is not installed. Reinstall or update Cockpit ZFS Manager.");
                await cockpit.spawn([helper, "delete", pool.name, scheduleId(pool.name)], { err: "out", superuser: "require" });
                configuration = null;
                status = await readStatus(pool.name, null);
                $("#scrub-schedule-status-" + pool.id).html(statusMarkup(null, status));
                $("#scrub-schedule-delete-confirm-" + pool.id + ", #btn-scrub-schedule-delete-" + pool.id).addClass("hidden");
                $("#input-scrub-schedule-delete-confirm-" + pool.id).val("");
                await refreshBadge(pool);
                FnDisplayAlert({ status: "success", title: "Scheduled scrub successfully deleted", description: pool.name, breakword: false }, { name: "scrub-schedule-delete", id: pool.id, timeout: 4 });
            } catch (error) {
                showInlineError(pool.id, "Scheduled scrub could not be deleted.", errorText(error));
            } finally {
                setBusy(pool.id, false);
            }
        });
    }

    async function open(pool) {
        let $modal = $("#modal-storagepool-scrub-schedule-" + pool.id);
        $modal.html('<div class="modal-dialog"><div class="modal-content"><div class="modal-body scrub-schedule-ct-loading"><div class="spinner spinner-lg"></div><p>Loading scheduled scrub...</p></div></div></div>');
        $modal.modal("show");
        try {
            let data = await load(pool.name);
            $modal.html(renderForm(pool, data.configuration, data.status));
            bindModal(pool, data.configuration, data.status);
            FnCockpitElementsUpdate();
        } catch (error) {
            $modal.html(renderForm(pool, null, { error: errorText(error) }));
            showInlineError(pool.id, "Scheduled scrub could not be loaded.", errorText(error));
            bindModal(pool, null, { error: errorText(error) });
            FnCockpitElementsUpdate();
        }
    }

    function registerPool(pool) {
        let modalId = "modal-storagepool-scrub-schedule-" + pool.id;
        $("#" + modalId).remove();
        $("#modals-storagepool-" + pool.id).append('<div id="' + modalId + '" aria-hidden="true" class="modal fade" data-backdrop="static" role="dialog" tabindex="-1"></div>');
        $("#btn-storagepool-scrub-schedule-" + pool.id).off("click.scrubSchedule").on("click.scrubSchedule", event => {
            event.preventDefault();
            open(pool);
        });
        refreshBadge(pool);
    }

    return { registerPool, refreshBadge, scheduleId, calendarFor };
})();

//#endregion
