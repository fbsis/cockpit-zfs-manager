//#region Replication Task

function FnReplicationWizardShowStep(modal, step) {
    let $modal = $(modal);
    let nextStep = Math.max(1, Math.min(4, Number(step) || 1));

    $modal.attr("data-replication-wizard-step", nextStep);
    $modal.find(".replication-ct-step").addClass("hidden").filter('[data-step="' + nextStep + '"]').removeClass("hidden");
    $modal.find(".replication-ct-steps li").removeClass("active complete").each(function () {
        let itemStep = Number($(this).attr("data-step"));
        $(this).toggleClass("active", itemStep === nextStep).toggleClass("complete", itemStep < nextStep);
    });
    $modal.find("[id^='btn-replication-task-back-']").toggleClass("hidden", nextStep === 1);
    $modal.find("[id^='btn-replication-task-next-']").toggleClass("hidden", nextStep === 4);
    $modal.find("[id^='btn-storagepool-replication-task-configure-run-']").toggleClass("hidden", nextStep !== 4);
    $modal.find("[id^='btn-storagepool-replication-task-apply-run-now-']").toggleClass("hidden", nextStep !== 4);

    if (nextStep === 4) {
        $modal.trigger("replication-wizard-review");
    }
}

$(document).on("click", "[id^='btn-replication-task-next-']", function (event) {
    event.preventDefault();
    let $modal = $(this).closest(".modal");
    let currentStep = Number($modal.attr("data-replication-wizard-step")) || 1;
    FnReplicationWizardShowStep($modal, currentStep + 1);
});

$(document).on("click", "[id^='btn-replication-task-back-']", function (event) {
    event.preventDefault();
    let $modal = $(this).closest(".modal");
    let currentStep = Number($modal.attr("data-replication-wizard-step")) || 1;
    FnReplicationWizardShowStep($modal, currentStep - 1);
});

$(document).on("click", ".replication-ct-steps li", function () {
    FnReplicationWizardShowStep($(this).closest(".modal"), Number($(this).attr("data-step")));
});

$(document).on("click", ".replication-ct-list-error", function (event) {
    event.preventDefault();
    let configureButton = $(this).attr("data-configure-button");
    if (configureButton) $(configureButton).trigger("click");
});

function znapzendUnitForReload(x) {
    if (x.match(/second/gi)) return 'Second';
    if (x.match(/minute/gi)) return 'Minute';
    if (x.match(/hour/gi)) return 'Hour';
    if (x.match(/day/gi)) return 'Day';
    if (x.match(/week/gi)) return 'Week';
    if (x.match(/month/gi)) return 'Month';
    if (x.match(/year/gi)) return 'Year';
}

function znapzendSplitNumberCharacter(x) {
    if (!x) return [];
    let number = Number(x.match(/[0-9]/g)?.join(''));
    let string = x.replace(/[0-9]/g, '');

    return [number, string];
}

function znapzendSplitPlan(x) {
    const [retention, interval] = x.split('=>');
    let retValue = Number(retention.match(/[0-9]/g)?.join(''));
    let retUnit = znapzendUnitForReload(retention);
    let intValue = Number(interval.match(/[0-9]/g)?.join(''));
    let intUnit = znapzendUnitForReload(interval);

    return {
        ret: retValue,
        retUnit,
        int: intValue,
        intUnit,
    };
}

function znapzendParseDestination(x) {
    let obj = { external: false, user: '', host: '', dataset: x, };

    if (!x) return {};
    if (!x.match(/[@:]/g)) return obj;

    obj.external = true;
    obj.user = x.split('@')[0];
    obj.host = x.split('@')[1].split(':')[0];
    obj.dataset = x.split(':')[1];

    return obj;
}

function replicationEscapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[character]);
}

function zfsReplicationJobHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function zfsReplicationJobId(sourceDataset) {
    let slug = String(sourceDataset || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "dataset";
    return slug + "-" + zfsReplicationJobHash(String(sourceDataset || ""));
}

function zfsReplicationJobStatePath(sourceDataset) {
    return "/var/lib/cockpit-zfs-manager/replication-jobs/" + zfsReplicationJobId(sourceDataset) + ".state";
}

function zfsReplicationParseProperties(output) {
    return String(output || "").split("\n").reduce((properties, line) => {
        let separator = line.indexOf("=");
        if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1);
        return properties;
    }, {});
}

async function FnReplicationTaskListStatus(dataset, configured, configurationError) {
    let status = {
        configured: configured === true,
        error: configured !== true && configured !== false,
        errorMessage: configurationError || "",
        running: false,
        lastEpoch: 0,
    };

    if (!status.configured) {
        if (status.error && !status.errorMessage) status.errorMessage = "Unable to determine whether the replication task is configured.";
        return status;
    }

    let jobState = null;
    try {
        let stateOutput = await cockpit.spawn(['/usr/bin/cat', zfsReplicationJobStatePath(dataset)], { err: "out", superuser: "try" });
        jobState = zfsReplicationParseProperties(stateOutput);
    } catch (error) {
        // A state file is created only after the first background run.
    }

    if (jobState) {
        if (jobState.status === "succeeded") status.lastEpoch = Number(jobState.finished_at) || 0;
        if (jobState.status === "failed") {
            status.error = true;
            status.errorMessage = "The latest background replication failed" + (jobState.phase ? " during " + jobState.phase : "") + (jobState.exit_code ? " (exit " + jobState.exit_code + ")" : "") + ".";
        }
        if (jobState.status === "queued" || jobState.status === "running") {
            status.running = true;
            try {
                let unitOutput = await cockpit.spawn(['/usr/bin/systemctl', 'show', jobState.unit, '--property=ActiveState'], { err: "out", superuser: "try" });
                let unitState = zfsReplicationParseProperties(unitOutput);
                let active = unitState.ActiveState === "active" || unitState.ActiveState === "activating" || unitState.ActiveState === "reloading";
                let stateAge = Math.floor(Date.now() / 1000) - Number(jobState.started_at || 0);
                if (!active && stateAge > 10) {
                    status.running = false;
                    status.error = true;
                    status.errorMessage = "The latest background replication was interrupted before completion.";
                }
            } catch (error) {
                let stateAge = Math.floor(Date.now() / 1000) - Number(jobState.started_at || 0);
                if (stateAge > 10) {
                    status.running = false;
                    status.error = true;
                    status.errorMessage = "The latest background replication unit could not be found.";
                }
            }
        }
    }

    try {
        let snapshotOutput = await cockpit.spawn(['/sbin/zfs', 'list', '-H', '-p', '-t', 'snapshot', '-r', dataset, '-o', 'name,creation', '-s', 'creation'], { err: "out", superuser: "try" });
        let prefix = dataset + "@";
        String(snapshotOutput || "").split("\n").forEach(line => {
            let fields = line.trim().split(/\s+/);
            if (fields[0] && fields[0].startsWith(prefix)) status.lastEpoch = Math.max(status.lastEpoch, Number(fields[1]) || 0);
        });
    } catch (error) {
        let details = [error && error.message, error && error.problem].filter(Boolean).join(" ").toLowerCase();
        if (!details.includes("no datasets available")) {
            status.error = true;
            if (!status.errorMessage) status.errorMessage = "The replication task exists, but its latest snapshot date could not be read.";
        }
    }

    return status;
}

function FnReplicationTaskRenderListStatus(status, filesystemId) {
    let lastText = status.lastEpoch > 0 ? "Last: " + new Date(status.lastEpoch * 1000).toLocaleString() : "Never run";
    let content;

    if (status.error) {
        let errorMessage = status.errorMessage || "Replication error";
        content = `<button class="btn btn-link replication-ct-list-error" data-configure-button="#btn-storagepool-replication-task-configure-${replicationEscapeHtml(filesystemId)}" title="${replicationEscapeHtml(errorMessage)}" type="button"><span aria-hidden="true" class="glyphicon glyphicon-exclamation-sign"></span><span class="sr-only">Open replication error</span></button><span class="replication-ct-list-details"><strong>Error</strong><small>${replicationEscapeHtml(lastText)}</small></span>`;
    } else if (status.configured) {
        content = `<span aria-hidden="true" class="glyphicon glyphicon-ok-sign replication-ct-list-icon replication-ct-list-icon-ok"></span><span class="replication-ct-list-details"><strong>${status.running ? "Running" : "Configured"}</strong><small>${replicationEscapeHtml(lastText)}</small></span>`;
    } else {
        content = `<span aria-hidden="true" class="glyphicon glyphicon-remove-sign replication-ct-list-icon replication-ct-list-icon-off"></span><span class="replication-ct-list-details"><strong>Not configured</strong></span>`;
    }

    return `<td class="replication-ct-list-cell"><span class="table-ct-head">Replication:</span><span class="replication-ct-list-status">${content}</span></td>`;
}

async function replicationFindExecutable(name, candidates) {
    try {
        let detected = await cockpit.spawn(['/bin/sh', '-c', 'command -v "$1"', 'cockpit-zfs-manager', name], { err: "out", superuser: "try" });
        if (detected.trim()) return detected.trim();
    } catch (error) {
        // Try known installation paths below.
    }

    for (const candidate of candidates) {
        try {
            let detected = await cockpit.spawn(['/bin/sh', '-c', 'test -x "$1" && printf "%s" "$1"', 'cockpit-zfs-manager', candidate], { err: "out", superuser: "try" });
            if (detected.trim()) return detected.trim();
        } catch (error) {
            // Continue checking the remaining known paths.
        }
    }

    try {
        let detected = await cockpit.spawn(['/bin/sh', '-c', 'find /opt -maxdepth 3 -type f -name "$1" -perm -111 -print -quit 2>/dev/null', 'cockpit-zfs-manager', name], { err: "out", superuser: "try" });
        if (detected.trim()) return detected.trim();
    } catch (error) {
        // No executable with this name was found under /opt.
    }

    return null;
}

async function replicationFindTrustedExecutable(candidates) {
    for (const candidate of candidates) {
        try {
            let detected = await cockpit.spawn(['/bin/sh', '-c', 'test -x "$1" && printf "%s" "$1"', 'cockpit-zfs-manager', candidate], { err: "out", superuser: "try" });
            if (detected.trim()) return detected.trim();
        } catch (error) {
            // Continue checking only the package-owned absolute paths.
        }
    }
    return null;
}

function FnModalReplicationTaskCreate(pool, filesystem) {
    let modal = {
        window: ""
    };

    let $el = $(`#modal-storagepool-replication-task-configure-` + filesystem.id);

    if ($el.length > 0) {
        $el.remove();
    }

    modal.window = `
        <div id="modal-storagepool-replication-task-configure-` + filesystem.id + `" aria-hidden="true" class="modal fade" data-backdrop="static" role="dialog" tabindex="-1"></div>

        <script nonce="1t55lZ7tzuKTreHVNwE66Ox32Mc=">
			$("#btn-storagepool-replication-task-configure-` + filesystem.id + `").on("click", function () {
                FnModalReplicationTaskCreateContent({id: '${pool.id}', name: '${pool.name}'}, {id: '${filesystem.id}', name: '${filesystem.name}', replicationtask: ${filesystem.replicationtask}}, { id: $("#modal-storagepool-replication-task-configure-` + filesystem.id + `"), tag: "#modal-storagepool-replication-task-configure-` + filesystem.id + `" });
            });
        </script>
    `;

    $("#modals-replication-tasks-" + pool.id).append(modal.window);
}

async function FnModalReplicationTaskCreateContent(pool, filesystem, modal) {
    let repTask = false;
    let useDst;
    let dstPlans;
    let dstScript;
    let srcPlans;
    let srcScript = `AddSrcPlan('#src-storagepool-replication-task-${filesystem.id}');`;
    let recursive;
    let mBufferSize;
    let destination;
    let loadError = "";
    let localPoolNames = [pool.name];
    let localDatasetNames = [];
    let znapzendCommand = await replicationFindExecutable('znapzend', [
        '/usr/bin/znapzend',
        '/usr/local/bin/znapzend',
        '/opt/znapzend/bin/znapzend',
    ]);
    let znapzendSetupCommand = await replicationFindExecutable('znapzendzetup', [
        '/usr/bin/znapzendzetup',
        '/usr/local/bin/znapzendzetup',
        '/opt/znapzend/bin/znapzendzetup',
    ]);
    let mbufferCommand = await replicationFindExecutable('mbuffer', [
        '/usr/bin/mbuffer',
        '/usr/local/bin/mbuffer',
    ]);
    let systemdRunCommand = await replicationFindExecutable('systemd-run', [
        '/usr/bin/systemd-run',
        '/bin/systemd-run',
    ]);
    let replicationJobHelper = await replicationFindTrustedExecutable([
        '/usr/share/cockpit/zfs/helpers/run-replication-job',
        '/usr/local/share/cockpit/zfs/helpers/run-replication-job',
    ]);
    let serverClock = {
        epoch: Math.floor(Date.now() / 1000),
        offsetSeconds: -new Date().getTimezoneOffset() * 60,
        timezone: 'server local time',
        readAt: Date.now(),
    };

    try {
        let clockOutput = await cockpit.spawn(['/bin/date', '+%s|%z|%Z'], { err: "out" });
        let [epoch, offset, timezone] = clockOutput.trim().split('|');
        if (!Number.isFinite(Number(epoch)) || !/^[+-]\d{4}$/.test(offset || '')) {
            throw new Error('The server returned an invalid date or timezone offset.');
        }
        let offsetSign = offset.startsWith('-') ? -1 : 1;
        serverClock.epoch = Number(epoch);
        serverClock.offsetSeconds = offsetSign * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(3, 5)) * 60);
        serverClock.timezone = timezone || serverClock.timezone;
        serverClock.readAt = Date.now();
    } catch (error) {
        // Fall back to the browser clock when the server clock cannot be read.
    }

    if (filesystem.replicationtask && znapzendSetupCommand) {
        try {
            repTask = true;

            let command = [znapzendSetupCommand, 'list', filesystem.name];

            let content = await cockpit.spawn(command, { err: "out", superuser: "require" });
            let lines = content.split('\n');
            let data = {};

            for (let index = 0; index < lines.length; index++) {
                const element = lines[index].trim();

                if (element.includes(' = ')) {
                    let parts = element.split(' = ');
                    data[parts[0]] = parts[1];
                }
            }

            useDst = !!data?.dst_a;
            dstPlans = data?.dst_a_plan?.split(',').map(plan => znapzendSplitPlan(plan));
            dstScript = '';
            if (dstPlans) dstScript = dstPlans.map(plan => `AddDstPlan("#dst-storagepool-replication-task-` + filesystem.id + `", JSON.parse('${JSON.stringify(plan)}'));`).join('');
            srcPlans = data?.src_plan.split(',').map(plan => znapzendSplitPlan(plan));
            srcScript = srcPlans.map(plan => `AddSrcPlan("#src-storagepool-replication-task-` + filesystem.id + `", JSON.parse('${JSON.stringify(plan)}'));`).join('');
            recursive = data?.recursive === 'on';
            mBufferSize = znapzendSplitNumberCharacter(data?.mbuffer_size);
            destination = znapzendParseDestination(data?.dst_a);
        } catch (error) {
            repTask = false;
            loadError = error.message || String(error);
            FnDisplayAlert({ status: "danger", title: "Replication task could not be loaded", description: "Open Review & Logs for details.", breakword: false }, { name: "replicationtask-configure" });
        }
    } else if (filesystem.replicationtask) {
        loadError = "znapzendzetup was not found. Install znapzend on this server before loading or editing replication tasks.";
    }

    try {
        let poolList = await cockpit.spawn(['/sbin/zpool', 'list', '-H', '-o', 'name'], { err: "out", superuser: "try" });
        localPoolNames = poolList.split('\n').map(name => name.trim()).filter(Boolean);
        if (!localPoolNames.includes(pool.name)) localPoolNames.push(pool.name);
    } catch (error) {
        // Keep the current pool available when the complete pool list cannot be loaded.
    }

    try {
        let datasetList = await cockpit.spawn(['/sbin/zfs', 'list', '-H', '-o', 'name', '-t', 'filesystem'], { err: "out", superuser: "try" });
        localDatasetNames = datasetList.split('\n').map(name => name.trim()).filter(Boolean);
    } catch (error) {
        // The pool root remains selectable if datasets cannot be enumerated.
    }

    localPoolNames = [...new Set(localPoolNames)].sort();
    let localPoolOptions = localPoolNames.map(name => `<option value="${replicationEscapeHtml(name)}">${replicationEscapeHtml(name)}</option>`).join('');

    modal.content = `
        <div class="modal-dialog modal-lg replication-ct-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h4 class="modal-title">Configure Replication Task</h4>
                </div>
                <div class="modal-body">
                    <div id="replication-task-background-banner-${filesystem.id}" class="alert alert-info hidden" role="status"></div>
                    <ol class="replication-ct-steps" aria-label="Replication configuration steps">
                        <li class="active" data-step="1"><span>1</span>Source</li>
                        <li data-step="2"><span>2</span>Retention</li>
                        <li data-step="3"><span>3</span>Destination</li>
                        <li data-step="4"><span>4</span>Review &amp; Logs</li>
                    </ol>
                    <section class="replication-ct-step" data-step="1">
                        <h5>Source dataset</h5>
                        <p class="help-block">Choose whether child datasets are included and select a transfer profile suitable for this server.</p>
                        ${!znapzendCommand || !znapzendSetupCommand || !mbufferCommand ? `<div class="alert alert-danger"><strong>Replication prerequisites are missing.</strong><br>${!znapzendCommand ? '<code>znapzend</code> was not found. Install znapzend on this server.<br>' : ''}${!znapzendSetupCommand ? '<code>znapzendzetup</code> was not found. Install znapzend on this server.<br>' : ''}${!mbufferCommand ? '<code>mbuffer</code> was not found. Install the mbuffer package.' : ''}</div>` : ''}
                        <div class="ct-form">
                            <label class="control-label">Dataset</label>
                            <div><strong>${filesystem.name}</strong></div>
                        </div>
                    <div class="ct-form">
                        <label class="control-label">Recursive</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `">
                            <input id="input-storagepool-replication-task-recursive-` + filesystem.id + `" class="privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="checkbox"${repTask && recursive ? ' checked' : ''}>
                        </div>
                        <label class="control-label" for="select-replication-task-mbuffer-preset-${filesystem.id}">Transfer profile</label>
                        <div>
                            <select id="select-replication-task-mbuffer-preset-${filesystem.id}" class="form-control">
                                <option value="low">Low memory — 256 MB</option>
                                <option value="normal">Normal — 512 MB</option>
                                <option value="fast"${repTask ? '' : ' selected'}>Fast/local — 1 GB (recommended)</option>
                                <option value="custom"${repTask ? ' selected' : ''}>Custom</option>
                            </select>
                            <span id="replication-task-mbuffer-preset-help-${filesystem.id}" class="help-block"></span>
                        </div>
                        <label class="control-label replication-ct-mbuffer-custom-${filesystem.id}${repTask ? '' : ' hidden'}">Custom buffer size</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper replication-ct-mbuffer-custom-${filesystem.id}${repTask ? '' : ' hidden'}">
                            <input id="input-storagepool-replication-task-mbuffersize-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${repTask && mBufferSize.length === 2 ? mBufferSize[0] : '1'}">
                            <span id="helpblock-storagepool-replication-task-` + filesystem.id + `" class="help-block"></span>
                        </div>
                        <label class="control-label replication-ct-mbuffer-custom-${filesystem.id}${repTask ? '' : ' hidden'}">Buffer unit</label>
                        <div class="ct-validation-wrapper replication-ct-mbuffer-custom-${filesystem.id}${repTask ? '' : ' hidden'}">
                            <div class="btn-group bootstrap-select dropdown form-control privileged-modal">
                                <button aria-expanded="false" class="btn btn-default dropdown-toggle" data-toggle="dropdown" tabIndex="1" type="button">
                                    <span id="btnspan-storagepool-replication-task-mbuffersize-unit-` + filesystem.id + `" class="pull-left" data-field-value="${repTask && mBufferSize.length === 2 ? mBufferSize[1] : 'G'}">${repTask && mBufferSize.length === 2 ? mBufferSize[1] : 'G'}</span>
                                    <div class="caret"></div>
                                </button>
                                <ul id="dropdown-storagepool-replication-task-mbuffersize-unit-` + filesystem.id + `" class="dropdown-menu">
                                    <li value="b"><a tabindex="-1">b</a></li>
                                    <li value="k"><a tabindex="-1">k</a></li>
                                    <li value="M"><a tabindex="-1">M</a></li>
                                    <li value="G"><a tabindex="-1">G</a></li>
                                </ul>
                            </div>
                        </div>
                    </div>
                    </section>
                    <section class="replication-ct-step hidden" data-step="2">
                        <h5>Snapshot schedule and retention</h5>
                        <p class="help-block">Choose a ready-made policy, then review the exact schedule below. You can combine multiple rules when you need different short- and long-term history.</p>
                        <div class="ct-form replication-ct-preset">
                            <label class="control-label" for="select-replication-task-src-preset-${filesystem.id}">Retention policy preset</label>
                            <select id="select-replication-task-src-preset-${filesystem.id}" class="form-control">
                                <option value="hourly"${repTask ? '' : ' selected'}>Hourly — keep 7 days</option>
                                <option value="daily">Daily — keep 30 days</option>
                                <option value="balanced">Balanced — hourly, daily and weekly history</option>
                                <option value="longterm">Long-term — daily, weekly and monthly history</option>
                                <option value="custom"${repTask ? ' selected' : ''}>Custom</option>
                            </select>
                            <span></span>
                            <p id="replication-task-src-preset-help-${filesystem.id}" class="help-block"></p>
                        </div>
                    <div class="mt-2">
                        <div class="replication-ct-rules-heading">
                            <div>
                                <h5 class="modal-title">Snapshot schedule rules</h5>
                                <p class="help-block">The selected policy creates the required schedule rules automatically. Adjust the displayed values when you need a custom policy.</p>
                            </div>
                        </div>
                        <div id="src-storagepool-replication-task-` + filesystem.id + `"></div>
                        <script nonce="1t55lZ7tzuKTreHVNwE66Ox32Mc=">${srcScript}</script>
                    </div>
                    </section>
                    <section class="replication-ct-step hidden" data-step="3">
                        <h5>Replication destination</h5>
                        <p class="help-block">The destination is optional. Without it, znapzend only manages snapshots and retention on the source.</p>
                        <div class="ct-form">
                            <label class="control-label">Enable replication</label>
                            <div>
                                <input id="input-storagepool-replication-task-use-destination-` + filesystem.id + `" class="privileged-modal" type="checkbox" ${repTask && useDst ? ' checked' : ''}>
                            </div>
                        </div>
                        <div class="replication-ct-route" aria-live="polite">
                            <div>
                                <span>Source pool</span>
                                <strong>${pool.name}</strong>
                            </div>
                            <div>
                                <span>Source dataset</span>
                                <strong>${filesystem.name}</strong>
                            </div>
                            <div class="replication-ct-route-arrow" aria-hidden="true">→</div>
                            <div>
                                <span>Destination pool / dataset</span>
                                <strong id="replication-task-destination-preview-${filesystem.id}">Replication disabled</strong>
                            </div>
                        </div>
                    <div class="mt-2" id="storagepool-replication-task-dst-plans-` + filesystem.id + `">
                        <div class="replication-ct-rules-heading">
                            <div>
                                <h5 class="modal-title">Destination retention rules</h5>
                                <p class="help-block">Choose how long replicated snapshots remain available at the destination.</p>
                            </div>
                        </div>
                        <div class="ct-form replication-ct-preset">
                            <label class="control-label" for="select-replication-task-dst-preset-${filesystem.id}">Destination retention preset</label>
                            <select id="select-replication-task-dst-preset-${filesystem.id}" class="form-control">
                                <option value="month"${repTask && useDst ? '' : ' selected'}>Standard — keep 30 days</option>
                                <option value="quarter">Extended — keep 90 days</option>
                                <option value="archive">Archive — keep weekly and monthly history</option>
                                <option value="mirror">Same retention as source</option>
                                <option value="custom"${repTask && useDst ? ' selected' : ''}>Custom</option>
                            </select>
                            <span></span>
                            <p id="replication-task-dst-preset-help-${filesystem.id}" class="help-block"></p>
                        </div>
                        <div id="dst-storagepool-replication-task-` + filesystem.id + `"></div>
                        <script nonce="1t55lZ7tzuKTreHVNwE66Ox32Mc=">${repTask && useDst ? dstScript : ''}</script>
                    </div>
                    <div class="ct-form" id="storagepool-replication-task-dst-inputs-` + filesystem.id + `">
                        <label class="control-label">External Destination</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `">
                            <input id="input-storagepool-replication-task-external-` + filesystem.id + `" class="privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="checkbox"${repTask && destination.external ? ' checked' : ''}>
                        </div>
                        <div class="replication-ct-ssh-info external-storagepool-replication-task-item-` + filesystem.id + `${repTask && destination.external ? '' : ' hidden'}">
                            <strong>SSH key authentication</strong>
                            <p>No password is stored or requested. Automatic replication requires passwordless SSH access from this server to the remote server.</p>
                            <ol>
                                <li>Install the local replication user's public SSH key in the remote user's <code>authorized_keys</code>.</li>
                                <li>Accept the remote server's host key before enabling the task.</li>
                                <li>Ensure the remote user can run <code>zfs receive</code> for the destination dataset.</li>
                            </ol>
                            <span>Connection test (run on this server):</span>
                            <code id="replication-task-ssh-test-${filesystem.id}">sudo ssh -o BatchMode=yes user@host true</code>
                            <small>SSH port 22 and the service account's default private key are used. znapzend normally runs as root.</small>
                        </div>
                        <label class="control-label external-storagepool-replication-task-item-` + filesystem.id + `${repTask && destination.external ? '' : ' hidden'}">SSH user</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper external-storagepool-replication-task-item-` + filesystem.id + `${repTask && destination.external ? '' : ' hidden'}">
                            <input id="input-storagepool-replication-task-user-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" placeholder="root" tabindex="2" type="text" value="${repTask && destination.user ? destination.user : ''}">
                            <span class="help-block">Account used to open the SSH connection and receive the ZFS stream.</span>
                        </div>
                        <label class="control-label external-storagepool-replication-task-item-` + filesystem.id + `${repTask && destination.external ? '' : ' hidden'}">Remote host</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper external-storagepool-replication-task-item-` + filesystem.id + `${repTask && destination.external ? '' : ' hidden'}">
                            <input id="input-storagepool-replication-task-host-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" placeholder="192.168.1.120" tabindex="2" type="text" value="${repTask && destination.host ? destination.host : ''}">
                            <span class="help-block">IP address or DNS name of the server containing the destination pool.</span>
                        </div>
                        <label class="control-label replication-ct-local-destination-${filesystem.id}">Destination pool</label>
                        <div class="ct-validation-wrapper replication-ct-local-destination-${filesystem.id}">
                            <select id="select-storagepool-replication-task-dst-pool-${filesystem.id}" class="form-control privileged-modal">${localPoolOptions}</select>
                            <span class="help-block">Select one of the pools currently imported on this server.</span>
                        </div>
                        <label class="control-label replication-ct-local-destination-${filesystem.id}">Dataset inside destination pool</label>
                        <div class="ct-validation-wrapper replication-ct-local-destination-${filesystem.id}">
                            <select id="select-storagepool-replication-task-dst-dataset-${filesystem.id}" class="form-control privileged-modal"></select>
                            <span class="help-block">For the first replication, create a new dataset. Select an existing dataset only when it already contains a common snapshot from this source.</span>
                        </div>
                        <label id="label-storagepool-replication-task-dst-dataset-${filesystem.id}" class="control-label replication-ct-manual-destination-${filesystem.id}">New dataset path</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper replication-ct-manual-destination-${filesystem.id}">
                            <input id="input-storagepool-replication-task-dst-dataset-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" placeholder="dataset" tabindex="2" type="text" value="${repTask && destination.dataset ? destination.dataset : ''}">
                            <span id="help-storagepool-replication-task-dst-dataset-${filesystem.id}" class="help-block">Enter the new dataset path inside the selected pool.</span>
                        </div>
                    </div>
                    </section>
                    <section class="replication-ct-step hidden" data-step="4">
                        <h5>Review configuration</h5>
                        <div id="replication-task-validation-${filesystem.id}" class="alert alert-danger hidden"></div>
                        <pre id="replication-task-summary-${filesystem.id}" class="replication-ct-log"></pre>
                        <h5>Configuration activity</h5>
                        <pre id="replication-task-operation-log-${filesystem.id}" class="replication-ct-log">No configuration attempt has been made in this session.</pre>
                        <div class="replication-ct-log-heading">
                            <h5>Background run</h5>
                            <button id="btn-replication-task-job-status-${filesystem.id}" class="btn btn-default" type="button">Refresh status</button>
                        </div>
                        <div id="replication-task-job-status-${filesystem.id}" class="replication-ct-job-status">No background run has been recorded for this dataset.</div>
                        <pre id="replication-task-job-logs-${filesystem.id}" class="replication-ct-log">Background job logs will appear here.</pre>
                        <div class="replication-ct-log-heading">
                            <h5>znapzend service logs</h5>
                            <button id="btn-replication-task-logs-${filesystem.id}" class="btn btn-default" type="button">Refresh logs</button>
                        </div>
                        <pre id="replication-task-logs-${filesystem.id}" class="replication-ct-log">Open this step or click Refresh logs to inspect the service.</pre>
                    </section>
                </div>
                <div class="modal-footer replication-ct-footer">
                    <div class="replication-ct-danger-action">
                        ${filesystem.replicationtask ? `<button id="btn-storagepool-replication-task-delete-${filesystem.id}" aria-label="Delete Replication Task" class="btn btn-danger apply privileged-modal replication-ct-delete-button" tabindex="-1" title="Delete Replication Task" type="button"><span aria-hidden="true" class="glyphicon glyphicon-trash"></span><span class="sr-only">Delete Replication Task</span></button>` : ''}
                    </div>
                    <div id="spinner-storagepool-replication-task-configure-` + filesystem.id + `" class="dialog-wait-ct pull-left hidden">
                        <div class="spinner spinner-sm"></div><span></span>
                    </div>
                    <div class="modal-ct-buttons">
                        <button class="btn btn-default cancel" data-dismiss="modal" tabindex="-1">Cancel</button>
                        <button id="btn-replication-task-back-${filesystem.id}" class="btn btn-default hidden" type="button">Back</button>
                        <button id="btn-replication-task-next-${filesystem.id}" class="btn btn-primary" type="button">Next</button>
                        <button id="btn-storagepool-replication-task-configure-run-` + filesystem.id + `" class="btn btn-primary apply privileged-modal hidden" tabindex="-1" type="button">Apply configuration</button>
                        <button id="btn-storagepool-replication-task-apply-run-now-` + filesystem.id + `" class="btn btn-primary apply privileged-modal hidden" tabindex="-1" type="button">Apply &amp; run now</button>
                    </div>
                </div>
            </div>

            <script nonce="1t55lZ7tzuKTreHVNwE66Ox32Mc=">
                (function () {
                ${repTask && useDst ? '' : `$("#storagepool-replication-task-dst-plans-${filesystem.id}").css('display', 'none');`}
                ${repTask && useDst ? '' : `$("#storagepool-replication-task-dst-inputs-${filesystem.id}").css('display', 'none');`}

                function replicationErrorText(error) {
                    if (!error) return "Unknown error returned by znapzend.";
                    if (error.problem === "not-found") return "The replication executable could not be started. Verify that znapzendzetup and mbuffer are installed and executable.";
                    let details = [error.message || String(error)];
                    if (error.commandOutput) details.push(error.commandOutput);
                    if (error.problem) details.push("Problem: " + error.problem);
                    if (error.exit_status !== undefined) details.push("Exit status: " + error.exit_status);
                    return details.filter(Boolean).join("\\n");
                }

                function replicationSpawn(command, options) {
                    return new Promise((resolve, reject) => {
                        cockpit.spawn(command, options).done(resolve).fail((error, output) => {
                            let failure = error || new Error(output || "Command failed without an error message.");
                            if (output) failure.commandOutput = output;
                            reject(failure);
                        });
                    });
                }

                const replicationJobSource = ${JSON.stringify(filesystem.name)};
                let replicationJobStatusTimer = null;
                let replicationJobLaunchPendingUntil = 0;

                function replicationJobId() {
                    return zfsReplicationJobId(replicationJobSource);
                }

                function replicationJobStatePath() {
                    return zfsReplicationJobStatePath(replicationJobSource);
                }

                function replicationParseProperties(output) {
                    return zfsReplicationParseProperties(output);
                }

                function replicationJobPhaseLabel(phase) {
                    return ({
                        "waiting-for-lock": "Waiting for another replication job",
                        "stopping-scheduler": "Stopping the scheduler",
                        "removing-incomplete-destination": "Removing the confirmed incomplete destination",
                        "replicating": "Creating and replicating the snapshot",
                        "verifying": "Verifying source and destination snapshots",
                        "restoring-scheduler": "Restarting the scheduler",
                        "completed": "Completed",
                        "failed": "Failed",
                        "lock-failed": "Could not acquire the replication lock",
                        "scheduler-stop-failed": "Could not stop the scheduler",
                        "scheduler-restore-failed": "Replication ended, but the scheduler could not be restarted",
                        "replication-failed": "znapzend reported a replication failure",
                        "source-snapshot-read-failed": "Could not read source snapshots",
                        "source-verification-failed": "No new source snapshot could be verified",
                        "destination-verification-failed": "No matching destination snapshot could be verified",
                        "destination-reset-failed": "Could not remove the confirmed incomplete destination"
                    })[phase] || phase || "Unknown";
                }

                function replicationJobDate(epoch) {
                    let value = Number(epoch);
                    return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toLocaleString() : "—";
                }

                async function replicationRefreshJobStatus() {
                    let statusElement = $("#replication-task-job-status-${filesystem.id}");
                    let logElement = $("#replication-task-job-logs-${filesystem.id}");
                    let banner = $("#replication-task-background-banner-${filesystem.id}");
                    let state;

                    if (replicationJobStatusTimer) {
                        clearTimeout(replicationJobStatusTimer);
                        replicationJobStatusTimer = null;
                    }

                    try {
                        let stateOutput = await replicationSpawn(['/usr/bin/cat', replicationJobStatePath()], { err: "out", superuser: "require" });
                        state = replicationParseProperties(stateOutput);
                    } catch (error) {
                        if (Date.now() < replicationJobLaunchPendingUntil) {
                            statusElement.attr("data-status", "queued").text("Status: Starting background job...");
                            logElement.text("Waiting for the background unit to write its initial state...");
                            banner.removeClass("hidden alert-success alert-danger alert-warning").addClass("alert-info").text("Replication is starting in the background. You may close or reload this page safely.");
                            $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", true);
                            replicationJobStatusTimer = setTimeout(replicationRefreshJobStatus, 1000);
                            return { state: {}, displayedStatus: "queued", unitState: {} };
                        }
                        statusElement.removeAttr("data-status").text("No background run has been recorded for this dataset.");
                        logElement.text("Background job logs will appear here.");
                        banner.addClass("hidden").empty();
                        $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", false);
                        return null;
                    }

                    let displayedStatus = state.status || "unknown";
                    let unitState = {};
                    if ((displayedStatus === "queued" || displayedStatus === "running") && state.unit) {
                        try {
                            let unitOutput = await replicationSpawn([
                                '/usr/bin/systemctl', 'show', state.unit,
                                '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus'
                            ], { err: "out", superuser: "require" });
                            unitState = replicationParseProperties(unitOutput);
                        } catch (error) {
                            unitState = { LoadState: "not-found", ActiveState: "inactive" };
                        }

                        let stillActive = unitState.ActiveState === "active" || unitState.ActiveState === "activating" || unitState.ActiveState === "reloading";
                        let stateAge = Math.floor(Date.now() / 1000) - Number(state.started_at || 0);
                        if (!stillActive && stateAge > 10) displayedStatus = "interrupted";
                    }

                    let statusLabel = ({
                        queued: "Queued",
                        running: "Running in background",
                        succeeded: "Completed successfully",
                        failed: "Failed",
                        interrupted: "Interrupted before completion"
                    })[displayedStatus] || displayedStatus;
                    let details = [
                        "Status: " + statusLabel,
                        "Phase: " + replicationJobPhaseLabel(state.phase),
                        "Started: " + replicationJobDate(state.started_at),
                        "Finished: " + replicationJobDate(state.finished_at),
                        "Systemd unit: " + (state.unit || "—")
                    ];
                    if (state.destination_enabled === "1") details.push("Destination: " + (state.destination || "—"));
                    if (state.exit_code) details.push("Exit status: " + state.exit_code);
                    statusElement.attr("data-status", displayedStatus).text(details.join("\\n"));
                    let jobActive = displayedStatus === "queued" || displayedStatus === "running";
                    $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", jobActive);

                    banner.removeClass("hidden alert-info alert-success alert-danger alert-warning");
                    if (jobActive) {
                        banner.addClass("alert-info").text("Replication is running in the background. You may close or reload this page safely.");
                    } else if (displayedStatus === "succeeded") {
                        banner.addClass("alert-success").text("The latest background replication completed successfully.");
                    } else {
                        banner.addClass(displayedStatus === "interrupted" ? "alert-warning" : "alert-danger").text("The latest background replication did not complete. Review its log below.");
                    }

                    if (state.unit) {
                        try {
                            let jobLog = await replicationSpawn(['journalctl', '-u', state.unit, '-n', '120', '--no-pager', '--output=short-iso'], { err: "out", superuser: "try" });
                            logElement.text(jobLog.trim() || "No journal entries are available for this job yet.");
                        } catch (error) {
                            logElement.text("Unable to read the background job log.\\n" + replicationErrorText(error));
                        }
                    }

                    if (displayedStatus === "queued" || displayedStatus === "running") {
                        replicationJobStatusTimer = setTimeout(replicationRefreshJobStatus, 2000);
                    }
                    return { state, displayedStatus, unitState };
                }

                function replicationSnapshotNames(output) {
                    return String(output || "").split("\\n").map(name => name.trim()).filter(Boolean);
                }

                function replicationSnapshotSuffix(name) {
                    let separator = name.indexOf("@");
                    return separator >= 0 ? name.slice(separator + 1) : "";
                }

                function replicationDatasetSnapshotSuffixes(snapshotNames, dataset) {
                    let prefix = dataset + "@";
                    return snapshotNames.filter(name => name.startsWith(prefix)).map(replicationSnapshotSuffix).filter(Boolean);
                }

                async function replicationReadSnapshots(dataset, external, user, host, allowMissing) {
                    let zfsArguments = ['list', '-H', '-t', 'snapshot', '-r', dataset, '-o', 'name', '-s', 'creation'];
                    let command = external
                        ? ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', user + '@' + host, 'zfs'].concat(zfsArguments)
                        : ['/sbin/zfs'].concat(zfsArguments);
                    try {
                        return replicationSnapshotNames(await replicationSpawn(command, { err: "out", superuser: "require" }));
                    } catch (error) {
                        let details = replicationErrorText(error).toLowerCase();
                        if (allowMissing && (details.includes("dataset does not exist") || details.includes("cannot open") || details.includes("no datasets available"))) {
                            return [];
                        }
                        throw error;
                    }
                }

                async function replicationDatasetExists(dataset, external, user, host) {
                    let zfsArguments = ['list', '-H', '-o', 'name', dataset];
                    let command = external
                        ? ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', user + '@' + host, 'zfs'].concat(zfsArguments)
                        : ['/sbin/zfs'].concat(zfsArguments);
                    try {
                        await replicationSpawn(command, { err: "out", superuser: "require" });
                        return true;
                    } catch (error) {
                        let details = replicationErrorText(error).toLowerCase();
                        if (details.includes("dataset does not exist") || details.includes("cannot open") || details.includes("does not exist")) return false;
                        throw error;
                    }
                }

                async function replicationReadDatasets(dataset, external, user, host) {
                    let zfsArguments = ['list', '-H', '-r', '-o', 'name', '-t', 'filesystem', dataset];
                    let command = external
                        ? ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', user + '@' + host, 'zfs'].concat(zfsArguments)
                        : ['/sbin/zfs'].concat(zfsArguments);
                    return replicationSnapshotNames(await replicationSpawn(command, { err: "out", superuser: "require" }));
                }

                function replicationRefreshLogs() {
                    let output = $("#replication-task-logs-${filesystem.id}");
                    output.text("Loading znapzend service logs...");
                    cockpit.spawn(["journalctl", "-u", "znapzend", "-n", "80", "--no-pager", "--output=short-iso"], { err: "out", superuser: "try" })
                        .then(data => output.text(data.trim() || "No znapzend service entries were found."))
                        .catch(error => output.text("Unable to read the znapzend service log.\\n" + replicationErrorText(error)));
                }

                const replicationServerClock = ${JSON.stringify(serverClock)};

                function replicationScheduleSummary() {
                    const unitSeconds = {
                        second: 1,
                        minute: 60,
                        hour: 3600,
                        day: 86400,
                        week: 604800,
                        month: 2592000,
                        year: 31557600,
                    };
                    let schedules = [];
                    $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]').each((i, el) => {
                        let id = el.dataset.id;
                        let value = Number($("#input-storagepool-replication-task-src-int-" + id).val());
                        let unit = $("#btnspan-storagepool-replication-task-src-int-unit-" + id).attr("data-field-value").toLowerCase();
                        schedules.push({ value, unit, seconds: value * unitSeconds[unit] });
                    });
                    schedules.sort((a, b) => a.seconds - b.seconds);
                    let schedule = schedules[0];
                    if (!schedule || !Number.isFinite(schedule.seconds) || schedule.seconds <= 0) {
                        return { frequency: "Not configured", next: "Unavailable" };
                    }

                    let elapsed = (Date.now() - replicationServerClock.readAt) / 1000;
                    let serverNow = replicationServerClock.epoch + elapsed;
                    let adjustedNow = serverNow + replicationServerClock.offsetSeconds;
                    let nextAdjusted = schedule.seconds * (Math.floor(adjustedNow / schedule.seconds) + 1);
                    let nextWallClock = new Date(nextAdjusted * 1000);
                    let pad = value => String(value).padStart(2, "0");
                    let formatted = nextWallClock.getUTCFullYear() + "-" + pad(nextWallClock.getUTCMonth() + 1) + "-" + pad(nextWallClock.getUTCDate()) + " " + pad(nextWallClock.getUTCHours()) + ":" + pad(nextWallClock.getUTCMinutes()) + ":" + pad(nextWallClock.getUTCSeconds()) + " " + replicationServerClock.timezone;
                    let unitLabel = schedule.unit + (schedule.value === 1 ? "" : "s");
                    let frequency = schedule.value === 1 && schedule.unit === "day"
                        ? "Daily at 00:00 (server local time)"
                        : "Every " + schedule.value + " " + unitLabel + ", aligned to the server clock";
                    return { frequency, next: formatted };
                }

                function replicationReview() {
                    let recursive = $("#input-storagepool-replication-task-recursive-${filesystem.id}").prop("checked") ? "Yes" : "No";
                    let destinationEnabled = $("#input-storagepool-replication-task-use-destination-${filesystem.id}").prop("checked");
                    let destinationDataset = replicationDestinationDataset();
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    let location = destinationDataset || "Not configured";
                    if (destinationEnabled && external) {
                        location = $("#input-storagepool-replication-task-user-${filesystem.id}").val() + "@" + $("#input-storagepool-replication-task-host-${filesystem.id}").val() + ":" + destinationDataset;
                    }
                    let sourcePlans = [];
                    $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]').each((i, el) => {
                        let id = el.dataset.id;
                        sourcePlans.push("Keep for " + $("#input-storagepool-replication-task-src-ret-" + id).val() + " " + $("#btnspan-storagepool-replication-task-src-ret-unit-" + id).text() + "; retain one snapshot per " + $("#input-storagepool-replication-task-src-int-" + id).val() + " " + $("#btnspan-storagepool-replication-task-src-int-unit-" + id).text() + " time slot");
                    });
                    let destinationPlans = [];
                    $('#dst-storagepool-replication-task-${filesystem.id} > [data-type="dst"]').each((i, el) => {
                        let id = el.dataset.id;
                        destinationPlans.push("Keep for " + $("#input-storagepool-replication-task-dst-ret-" + id).val() + " " + $("#btnspan-storagepool-replication-task-dst-ret-unit-" + id).text() + "; retain one snapshot per " + $("#input-storagepool-replication-task-dst-int-" + id).val() + " " + $("#btnspan-storagepool-replication-task-dst-int-unit-" + id).text() + " time slot");
                    });
                    let schedule = replicationScheduleSummary();
                    $("#replication-task-summary-${filesystem.id}").text([
                        "Source: ${filesystem.name}",
                        "Recursive: " + recursive,
                        "mBuffer: " + $("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").val() + $("#btnspan-storagepool-replication-task-mbuffersize-unit-${filesystem.id}").text(),
                        "Snapshot creation schedule: " + schedule.frequency,
                        "Next scheduled snapshot: " + schedule.next,
                        sourcePlans.length > 1 ? "Schedule note: snapshots use the shortest interval below; the other rules only define how history is retained." : "",
                        "Source retention plans:\\n  - " + sourcePlans.join("\\n  - "),
                        "Replication enabled: " + (destinationEnabled ? "Yes" : "No"),
                        "Destination: " + (destinationEnabled ? location : "Snapshots only; no replication destination"),
                        destinationEnabled ? "Destination retention plans:\\n  - " + destinationPlans.join("\\n  - ") : ""
                    ].filter(Boolean).join("\\n"));
                }

                function replicationDestinationPreview() {
                    let enabled = $("#input-storagepool-replication-task-use-destination-${filesystem.id}").prop("checked");
                    let dataset = replicationDestinationDataset();
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    let preview = "Replication disabled";

                    if (enabled && !dataset) {
                        preview = "Select a destination pool / dataset";
                    } else if (enabled && external) {
                        let user = $("#input-storagepool-replication-task-user-${filesystem.id}").val().trim() || "user";
                        let host = $("#input-storagepool-replication-task-host-${filesystem.id}").val().trim() || "host";
                        preview = user + "@" + host + ":" + dataset + " (pool: " + dataset.split("/")[0] + ")";
                    } else if (enabled) {
                        preview = dataset + " (local pool: " + dataset.split("/")[0] + ")";
                    }

                    $("#replication-task-destination-preview-${filesystem.id}").text(preview);
                    let sshUser = $("#input-storagepool-replication-task-user-${filesystem.id}").val().trim() || "user";
                    let sshHost = $("#input-storagepool-replication-task-host-${filesystem.id}").val().trim() || "host";
                    $("#replication-task-ssh-test-${filesystem.id}").text("sudo ssh -o BatchMode=yes " + sshUser + "@" + sshHost + " true");
                }

                function replicationValidationErrors(runNow) {
                    let errors = [];
                    let mBufferSize = Number($("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").val());
                    let sourcePlans = $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]');
                    let destinationEnabled = $("#input-storagepool-replication-task-use-destination-${filesystem.id}").prop("checked");
                    let destinationPlans = $('#dst-storagepool-replication-task-${filesystem.id} > [data-type="dst"]');
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    if (!${JSON.stringify(!!znapzendCommand)}) errors.push("znapzend was not found. Install znapzend on this server.");
                    if (!${JSON.stringify(!!znapzendSetupCommand)}) errors.push("znapzendzetup was not found. Install the znapzend package on this server.");
                    if (!${JSON.stringify(!!mbufferCommand)}) errors.push("mbuffer was not found. Install the mbuffer package on this server.");
                    if (runNow && !${JSON.stringify(!!systemdRunCommand)}) errors.push("systemd-run was not found. It is required for a persistent background run.");
                    if (runNow && !${JSON.stringify(!!replicationJobHelper)}) errors.push("The background replication helper is missing. Reinstall Cockpit ZFS Manager.");
                    if (!Number.isFinite(mBufferSize) || mBufferSize <= 0) errors.push("mBuffer size must be greater than zero.");
                    if (!sourcePlans.length) errors.push("Add at least one source retention plan.");
                    sourcePlans.each((i, el) => {
                        let id = el.dataset.id;
                        if (Number($("#input-storagepool-replication-task-src-ret-" + id).val()) <= 0 || Number($("#input-storagepool-replication-task-src-int-" + id).val()) <= 0) errors.push("Source retention and interval values must be greater than zero.");
                    });
                    if (destinationEnabled && !replicationDestinationDataset()) errors.push("Select the destination pool / dataset.");
                    if (destinationEnabled && replicationDestinationDataset() && !/^[A-Za-z0-9_.:-]+(?:\\/[A-Za-z0-9_.:-]+)*$/.test(replicationDestinationDataset())) errors.push("Destination dataset contains unsupported characters.");
                    if (destinationEnabled && !destinationPlans.length) errors.push("Add at least one destination retention plan.");
                    if (destinationEnabled) destinationPlans.each((i, el) => {
                        let id = el.dataset.id;
                        if (Number($("#input-storagepool-replication-task-dst-ret-" + id).val()) <= 0 || Number($("#input-storagepool-replication-task-dst-int-" + id).val()) <= 0) errors.push("Destination retention and interval values must be greater than zero.");
                    });
                    if (destinationEnabled && external && !$("#input-storagepool-replication-task-user-${filesystem.id}").val().trim()) errors.push("Enter the SSH user for the external destination.");
                    if (destinationEnabled && external && !$("#input-storagepool-replication-task-host-${filesystem.id}").val().trim()) errors.push("Enter the host for the external destination.");
                    if (destinationEnabled && external && !/^[A-Za-z0-9._-]+$/.test($("#input-storagepool-replication-task-user-${filesystem.id}").val().trim())) errors.push("SSH user contains unsupported characters.");
                    if (destinationEnabled && external && !/^[A-Za-z0-9._:\\[\\]-]+$/.test($("#input-storagepool-replication-task-host-${filesystem.id}").val().trim())) errors.push("Remote host contains unsupported characters.");
                    if (destinationEnabled && !external && replicationDestinationDataset() === "${filesystem.name}") errors.push("Source and destination datasets must be different.");
                    return errors;
                }

                $("#modal-storagepool-replication-task-configure-${filesystem.id}").on("replication-wizard-review", function () {
                    replicationReview();
                    replicationRefreshLogs();
                    replicationRefreshJobStatus();
                });
                $("#btn-replication-task-logs-${filesystem.id}").on("click", replicationRefreshLogs);
                $("#btn-replication-task-job-status-${filesystem.id}").on("click", replicationRefreshJobStatus);
                $("#modal-storagepool-replication-task-configure-${filesystem.id}").on("hidden.bs.modal", function () {
                    if (replicationJobStatusTimer) clearTimeout(replicationJobStatusTimer);
                });
                $("#input-storagepool-replication-task-use-destination-${filesystem.id}, #input-storagepool-replication-task-external-${filesystem.id}, #input-storagepool-replication-task-user-${filesystem.id}, #input-storagepool-replication-task-host-${filesystem.id}, #select-storagepool-replication-task-dst-pool-${filesystem.id}, #select-storagepool-replication-task-dst-dataset-${filesystem.id}, #input-storagepool-replication-task-dst-dataset-${filesystem.id}").on("input change", replicationDestinationPreview);
                replicationDestinationPreview();

                const replicationSourcePresets = {
                    hourly: {
                        description: "Creates a snapshot every hour and keeps seven days of history.",
                        plans: [{ ret: "7", retUnit: "Day", int: "1", intUnit: "Hour" }]
                    },
                    daily: {
                        description: "Creates one snapshot per day and keeps thirty days of history.",
                        plans: [{ ret: "30", retUnit: "Day", int: "1", intUnit: "Day" }]
                    },
                    balanced: {
                        description: "Keeps hourly snapshots for 7 days, daily snapshots for 30 days and weekly snapshots for 1 year.",
                        plans: [
                            { ret: "7", retUnit: "Day", int: "1", intUnit: "Hour" },
                            { ret: "30", retUnit: "Day", int: "1", intUnit: "Day" },
                            { ret: "1", retUnit: "Year", int: "1", intUnit: "Week" }
                        ]
                    },
                    longterm: {
                        description: "Keeps daily snapshots for 30 days, weekly snapshots for 1 year and monthly snapshots for 5 years.",
                        plans: [
                            { ret: "30", retUnit: "Day", int: "1", intUnit: "Day" },
                            { ret: "1", retUnit: "Year", int: "1", intUnit: "Week" },
                            { ret: "5", retUnit: "Year", int: "1", intUnit: "Month" }
                        ]
                    }
                };

                const replicationDestinationPresets = {
                    month: {
                        description: "Keeps destination snapshots for 30 days with hourly recovery points.",
                        plans: [{ ret: "30", retUnit: "Day", int: "1", intUnit: "Hour" }]
                    },
                    quarter: {
                        description: "Keeps destination snapshots for 90 days with daily recovery points.",
                        plans: [{ ret: "90", retUnit: "Day", int: "1", intUnit: "Day" }]
                    },
                    archive: {
                        description: "Keeps weekly recovery points for 1 year and monthly recovery points for 5 years.",
                        plans: [
                            { ret: "1", retUnit: "Year", int: "1", intUnit: "Week" },
                            { ret: "5", retUnit: "Year", int: "1", intUnit: "Month" }
                        ]
                    }
                };

                function replicationSourcePlanValues() {
                    let plans = [];
                    $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]').each((i, el) => {
                        let id = el.dataset.id;
                        plans.push({
                            ret: $("#input-storagepool-replication-task-src-ret-" + id).val(),
                            retUnit: $("#btnspan-storagepool-replication-task-src-ret-unit-" + id).text(),
                            int: $("#input-storagepool-replication-task-src-int-" + id).val(),
                            intUnit: $("#btnspan-storagepool-replication-task-src-int-unit-" + id).text()
                        });
                    });
                    return plans;
                }

                $("#select-replication-task-src-preset-${filesystem.id}").on("change", function () {
                    let preset = replicationSourcePresets[this.value];
                    if (!preset) {
                        $("#replication-task-src-preset-help-${filesystem.id}").text("Manually configure one or more retention plans below.");
                        return;
                    }
                    $("#replication-task-src-preset-help-${filesystem.id}").text(preset.description);
                    $("#src-storagepool-replication-task-${filesystem.id}").empty();
                    preset.plans.forEach(plan => AddSrcPlan("#src-storagepool-replication-task-${filesystem.id}", plan));
                }).trigger("change");

                $("#select-replication-task-dst-preset-${filesystem.id}").on("change", function () {
                    let preset = replicationDestinationPresets[this.value];
                    if (this.value === "mirror") {
                        preset = { description: "Uses the same schedule and retention policy configured for the source.", plans: replicationSourcePlanValues() };
                    }
                    if (!preset) {
                        $("#replication-task-dst-preset-help-${filesystem.id}").text("Manually configure one or more destination retention plans below.");
                        return;
                    }
                    $("#replication-task-dst-preset-help-${filesystem.id}").text(preset.description);
                    $("#dst-storagepool-replication-task-${filesystem.id}").empty();
                    preset.plans.forEach(plan => AddDstPlan("#dst-storagepool-replication-task-${filesystem.id}", plan));
                }).trigger("change");

                $("#src-storagepool-replication-task-${filesystem.id}").on("input", "input", () => {
                    $("#select-replication-task-src-preset-${filesystem.id}").val("custom");
                    $("#replication-task-src-preset-help-${filesystem.id}").text("Custom plan — values were adjusted manually.");
                }).on("click", ".dropdown-menu a", () => {
                    $("#select-replication-task-src-preset-${filesystem.id}").val("custom");
                    $("#replication-task-src-preset-help-${filesystem.id}").text("Custom plan — values were adjusted manually.");
                });

                $("#dst-storagepool-replication-task-${filesystem.id}").on("input", "input", () => {
                    $("#select-replication-task-dst-preset-${filesystem.id}").val("custom");
                    $("#replication-task-dst-preset-help-${filesystem.id}").text("Custom plan — values were adjusted manually.");
                }).on("click", ".dropdown-menu a", () => {
                    $("#select-replication-task-dst-preset-${filesystem.id}").val("custom");
                    $("#replication-task-dst-preset-help-${filesystem.id}").text("Custom plan — values were adjusted manually.");
                });

                const replicationMbufferPresets = {
                    low: { size: "256", unit: "M", description: "Uses less RAM; suitable for small servers or slower links." },
                    normal: { size: "512", unit: "M", description: "Balanced memory usage for typical network replication." },
                    fast: { size: "1", unit: "G", description: "Recommended for fast networks and local replication." }
                };

                $("#select-replication-task-mbuffer-preset-${filesystem.id}").on("change", function () {
                    let preset = replicationMbufferPresets[this.value];
                    $(".replication-ct-mbuffer-custom-${filesystem.id}").toggleClass("hidden", !!preset);
                    if (!preset) {
                        $("#replication-task-mbuffer-preset-help-${filesystem.id}").text("Set the buffer size manually using the advanced fields below.");
                        return;
                    }
                    $("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").val(preset.size);
                    $("#btnspan-storagepool-replication-task-mbuffersize-unit-${filesystem.id}").text(preset.unit).attr("data-field-value", preset.unit);
                    $("#replication-task-mbuffer-preset-help-${filesystem.id}").text(preset.description);
                }).trigger("change");

                $("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").on("input", () => {
                    $("#select-replication-task-mbuffer-preset-${filesystem.id}").val("custom");
                    $("#replication-task-mbuffer-preset-help-${filesystem.id}").text("Custom buffer size.");
                });

                $("#dropdown-storagepool-replication-task-mbuffersize-unit-` + filesystem.id + `").on("click", "li a", function () {
                    $("#btnspan-storagepool-replication-task-mbuffersize-unit-` + filesystem.id + `").text($(this).text()).attr("data-field-value", $(this).parent().attr("value"));
                    $("#select-replication-task-mbuffer-preset-${filesystem.id}").val("custom");
                    $("#replication-task-mbuffer-preset-help-${filesystem.id}").text("Custom buffer size.");
                    $(this).parent().siblings().removeClass("active");
                    $(this).parent().addClass("active");
                });

                const replicationLocalDatasets = ${JSON.stringify(localDatasetNames).replace(/</g, '\\u003c')};

                function replicationToggleManualDestination() {
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    let custom = $("#select-storagepool-replication-task-dst-dataset-${filesystem.id}").val() === "__custom__";
                    $(".replication-ct-manual-destination-${filesystem.id}").toggleClass("hidden", !external && !custom);
                    $("#label-storagepool-replication-task-dst-dataset-${filesystem.id}").text(external ? "Remote pool / dataset" : "New dataset path");
                    $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").attr("placeholder", external ? "backup-pool/dataset" : "backups/rpool");
                    $("#help-storagepool-replication-task-dst-dataset-${filesystem.id}").text(external
                        ? "Enter the complete remote ZFS path. The first segment is the remote destination pool."
                        : "Enter a path inside the selected pool. The pool name is added automatically.");
                }

                function replicationToggleExternalFields() {
                    let checked = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    $(".external-storagepool-replication-task-item-${filesystem.id}").toggleClass("hidden", !checked);
                    $(".replication-ct-local-destination-${filesystem.id}").toggleClass("hidden", checked);
                    replicationToggleManualDestination();
                }

                function replicationPopulateLocalDatasets(preferredDataset) {
                    let destinationPool = $("#select-storagepool-replication-task-dst-pool-${filesystem.id}").val() || "${pool.name}";
                    let select = $("#select-storagepool-replication-task-dst-dataset-${filesystem.id}").empty();
                    select.append($("<option>").val(destinationPool).text(destinationPool + " — pool root"));
                    replicationLocalDatasets.filter(name => name.startsWith(destinationPool + "/")).forEach(name => {
                        select.append($("<option>").val(name).text(name.slice(destinationPool.length + 1)));
                    });
                    select.append($("<option>").val("__custom__").text("Create a new dataset…"));

                    if (preferredDataset && select.find("option").filter((i, option) => option.value === preferredDataset).length) {
                        select.val(preferredDataset);
                    } else if (preferredDataset) {
                        select.val("__custom__");
                        let prefix = destinationPool + "/";
                        $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val(preferredDataset.startsWith(prefix) ? preferredDataset.slice(prefix.length) : preferredDataset);
                    } else {
                        select.val(destinationPool);
                        $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val("");
                    }
                    replicationToggleManualDestination();
                }

                function replicationInitializeLocalDestination() {
                    let configuredDataset = $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val().trim();
                    let configuredPool = configuredDataset.split("/")[0];
                    let poolSelect = $("#select-storagepool-replication-task-dst-pool-${filesystem.id}");
                    let poolNames = poolSelect.find("option").map((i, option) => option.value).get();
                    poolSelect.val(poolNames.includes(configuredPool) ? configuredPool : "${pool.name}");
                    replicationPopulateLocalDatasets(configuredDataset || null);
                }

                function replicationDestinationDataset() {
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    let dataset = $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val().trim().replace(/^\\/+|\\/+$/g, "");
                    if (external) return dataset;
                    let destinationPool = $("#select-storagepool-replication-task-dst-pool-${filesystem.id}").val() || "";
                    let selectedDataset = $("#select-storagepool-replication-task-dst-dataset-${filesystem.id}").val();
                    if (selectedDataset === "__custom__") return dataset ? destinationPool + "/" + dataset : "";
                    return selectedDataset || destinationPool;
                }

                $("#input-storagepool-replication-task-external-${filesystem.id}").on("change", () => {
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    if (external) {
                        let selectedDataset = $("#select-storagepool-replication-task-dst-dataset-${filesystem.id}").val();
                        if (selectedDataset && selectedDataset !== "__custom__") {
                            $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val(selectedDataset);
                        } else {
                            let selectedPool = $("#select-storagepool-replication-task-dst-pool-${filesystem.id}").val();
                            let dataset = $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val().trim().replace(/^\\/+|\\/+$/g, "");
                            $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val(selectedPool + (dataset ? "/" + dataset : ""));
                        }
                    } else {
                        replicationInitializeLocalDestination();
                    }
                    replicationToggleExternalFields();
                    replicationDestinationPreview();
                });
                $("#select-storagepool-replication-task-dst-pool-${filesystem.id}").on("change", () => {
                    replicationPopulateLocalDatasets(null);
                    replicationDestinationPreview();
                });
                $("#select-storagepool-replication-task-dst-dataset-${filesystem.id}").on("change", () => {
                    replicationToggleManualDestination();
                    replicationDestinationPreview();
                });
                $("#input-storagepool-replication-task-use-destination-` + filesystem.id + `").on("input", () => {
                    let e = $("#input-storagepool-replication-task-use-destination-` + filesystem.id + `");
                    let checked = e.get(0).checked;

                    $("#storagepool-replication-task-dst-plans-` + filesystem.id + `").css('display', checked ? 'block' : 'none');
                    $("#storagepool-replication-task-dst-inputs-` + filesystem.id + `").css('display', checked ? 'grid' : 'none');

                    if (checked) {
                        if (!$("#dst-storagepool-replication-task-` + filesystem.id + `").children().length) {
                            AddDstPlan("#dst-storagepool-replication-task-` + filesystem.id + `");
                        }
                    } else {
                        $("#dst-storagepool-replication-task-` + filesystem.id + `").empty();
                    }
                });

                function changeUnit(x) {
                    if (x.match(/second/gi)) return 's';
                    if (x.match(/minute/gi)) return 'min';
                    if (x.match(/hour/gi)) return 'h';
                    if (x.match(/day/gi)) return 'd';
                    if (x.match(/week/gi)) return 'w';
                    if (x.match(/month/gi)) return 'm';
                    if (x.match(/year/gi)) return 'y';
                }

                $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}").on("click", event => {
                    event.preventDefault();
                    let runNow = event.currentTarget.id === "btn-storagepool-replication-task-apply-run-now-${filesystem.id}";
                    $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Preparing replication configuration...");
                    try {
                    let validationErrors = replicationValidationErrors(runNow);
                    if (validationErrors.length) {
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").html("<strong>Correct these fields before applying:</strong><ul><li>" + validationErrors.join("</li><li>") + "</li></ul>");
                        return;
                    }
                    $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", true);
                    let recursive = $("#input-storagepool-replication-task-recursive-` + filesystem.id + `").get(0).checked;
                    let useDestination = $("#input-storagepool-replication-task-use-destination-` + filesystem.id + `").get(0).checked;

                    let mBufferSizeValue = $("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").val();
                    let mBufferSizeUnit = $("#btnspan-storagepool-replication-task-mbuffersize-unit-${filesystem.id}").attr("data-field-value");

                    let srcPlanElements = $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]');

                    let dstPlanElements = $('#dst-storagepool-replication-task-${filesystem.id} > [data-type="dst"]');
                    let externalUser = $("#input-storagepool-replication-task-user-${filesystem.id}").val();
                    let externalHost = $("#input-storagepool-replication-task-host-${filesystem.id}").val();
                    let dstDataset = replicationDestinationDataset();

                    let srcDataset = '${filesystem.name}';

                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").get(0).checked;
                    let createDestinationDataset = useDestination && !external && $("#select-storagepool-replication-task-dst-dataset-${filesystem.id}").val() === "__custom__";

                    let mBufferSize = mBufferSizeValue + mBufferSizeUnit;
                    let srcPlans = [];
                    let dstPlans = [];

                    let dstLocation = [];

                    if (external) {
                        dstLocation.push(externalUser);
                        dstLocation.push('@');
                        dstLocation.push(externalHost);
                        dstLocation.push(':');
                    }

                    dstLocation.push(dstDataset);

                    dstLocation = dstLocation.join('');

                    srcPlanElements.each((i, el) => {
                        let id = el.dataset.id;
                        let retValue = $('#input-storagepool-replication-task-src-ret-' + id).val();
                        let retUnit = changeUnit($('#btnspan-storagepool-replication-task-src-ret-unit-' + id).attr("data-field-value"));
                        let intValue = $('#input-storagepool-replication-task-src-int-' + id).val();
                        let intUnit = changeUnit($('#btnspan-storagepool-replication-task-src-int-unit-' + id).attr("data-field-value"));

                        srcPlans.push({
                            ret: retValue + retUnit,
                            int: intValue + intUnit,
                        });
                    });

                    dstPlanElements.each((i, el) => {
                        let id = el.dataset.id;
                        let retValue = $('#input-storagepool-replication-task-dst-ret-' + id).val();
                        let retUnit = changeUnit($('#btnspan-storagepool-replication-task-dst-ret-unit-' + id).attr("data-field-value"));
                        let intValue = $('#input-storagepool-replication-task-dst-int-' + id).val();
                        let intUnit = changeUnit($('#btnspan-storagepool-replication-task-dst-int-unit-' + id).attr("data-field-value"));

                        dstPlans.push({
                            ret: retValue + retUnit,
                            int: intValue + intUnit,
                        });
                    });

                    let srcPlan = srcPlans.map(i => \`\${i.ret}=>\${i.int}\`).join(',');
                    let dstPlan = dstPlans.map(i => \`\${i.ret}=>\${i.int}\`).join(',');

                    let command = [
                        ${JSON.stringify(znapzendSetupCommand || 'znapzendzetup')},
                        '${filesystem.replicationtask ? 'edit' : 'create'}',
                        ${filesystem.replicationtask ? "recursive ? '--recursive=on' : '--recursive=off'" : "recursive ? '--recursive' : null"},
                        '--donotask',
                        ${JSON.stringify('--mbuffer=' + (mbufferCommand || '/usr/bin/mbuffer'))},
                        \`--mbuffersize=\${mBufferSize}\`,
                        'SRC',
                        \`\${srcPlan}\`,
                        srcDataset,
                    ].filter(x => x !== null);

                    if (useDestination) {
                        command.push('DST:a');
                        command.push(\`\${dstPlan}\`);
                        command.push(dstLocation);
                    }

                    $("#spinner-storagepool-replication-task-configure-${filesystem.id}").removeClass("hidden");
                    $("#spinner-storagepool-replication-task-configure-${filesystem.id} span").text("Configuring replication task...");
                    $("#replication-task-validation-${filesystem.id}").addClass("hidden").empty();
                    $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Running:\\n" + command.join(" ") + "\\n\\nWaiting for znapzendzetup...");

                    let runConfiguration = () => cockpit.spawn(command, { err: "out", superuser: "require" });
                    let removeOldDestination = ${repTask && useDst} && !useDestination;
                    let process = removeOldDestination
                        ? cockpit.spawn([${JSON.stringify(znapzendSetupCommand || 'znapzendzetup')}, 'delete', '--dst=a', '${filesystem.name}'], { err: "out", superuser: "require" }).then(runConfiguration)
                        : runConfiguration();

                    async function replicationStartBackground(configurationLog) {
                        $("#spinner-storagepool-replication-task-configure-${filesystem.id} span").text("Starting background replication...");
                        $("#replication-task-operation-log-${filesystem.id}").text(configurationLog + "\\n\\nValidating replication history before starting the background job...");

                        try {
                            if (createDestinationDataset) {
                                await replicationSpawn([${JSON.stringify(znapzendSetupCommand || 'znapzendzetup')}, 'enable-dst-autocreation', '${filesystem.name}', 'a'], { err: "out", superuser: "require" });
                            }
                            await replicationSpawn(['/usr/bin/systemctl', 'reset-failed', 'znapzend.service'], { err: "out", superuser: "require" });

                            let currentJob = await replicationRefreshJobStatus();
                            if (currentJob && (currentJob.displayedStatus === "queued" || currentJob.displayedStatus === "running")) {
                                throw new Error("A replication job for ${filesystem.name} is already running in background unit " + currentJob.state.unit + ".");
                            }

                            let snapshotsBefore = await replicationReadSnapshots('${filesystem.name}', false, "", "", false);
                            let destinationExists = useDestination
                                ? await replicationDatasetExists(dstDataset, external, externalUser, externalHost)
                                : false;
                            let destinationSnapshotsBefore = useDestination && destinationExists
                                ? await replicationReadSnapshots(dstDataset, external, externalUser, externalHost, false)
                                : [];
                            let recoveredIncompleteDestination = false;

                            if (useDestination) {
                                let sourceExistingSuffixes = new Set(replicationDatasetSnapshotSuffixes(snapshotsBefore, '${filesystem.name}'));
                                let destinationExistingSuffixes = replicationDatasetSnapshotSuffixes(destinationSnapshotsBefore, dstDataset);
                                let hasCommonSnapshot = destinationExistingSuffixes.some(suffix => sourceExistingSuffixes.has(suffix));
                                if (destinationExists && !hasCommonSnapshot) {
                                    let canRecoverLocally = !external && destinationSnapshotsBefore.length === 0;
                                    if (canRecoverLocally) {
                                        let destinationDatasets = await replicationReadDatasets(dstDataset, false, "", "");
                                        if (destinationDatasets.length > 1) {
                                            let childError = new Error("Destination dataset " + dstLocation + " has child datasets and no common snapshot with ${filesystem.name}.");
                                            childError.commandOutput = "The manager will not remove a dataset tree automatically. Choose a new destination dataset or recover it manually.";
                                            throw childError;
                                        }

                                        let confirmation = window.prompt(
                                            "The destination " + dstLocation + " has no snapshots and no common replication history. It may have been left by the interrupted initial run.\\n\\n" +
                                            "To retry, the background job must permanently delete this exact dataset first. ALL files and properties currently inside it will be removed. Child datasets are never removed by this recovery action.\\n\\n" +
                                            "Type the exact dataset name to approve, or choose Cancel to leave it unchanged:\\n" + dstDataset,
                                            ""
                                        );
                                        if (confirmation !== dstDataset) {
                                            let cancelledError = new Error("Destination dataset " + dstLocation + " already exists, but it has no common snapshot with ${filesystem.name}.");
                                            cancelledError.commandOutput = "The destination was left unchanged. Choose a new dataset path, or run again and explicitly approve removal of the incomplete destination.";
                                            throw cancelledError;
                                        }

                                        await replicationSpawn([${JSON.stringify(znapzendSetupCommand || 'znapzendzetup')}, 'enable-dst-autocreation', '${filesystem.name}', 'a'], { err: "out", superuser: "require" });
                                        recoveredIncompleteDestination = true;
                                    } else {
                                        let historyError = new Error("Destination dataset " + dstLocation + " already exists, but it has no common snapshot with ${filesystem.name}. A full initial ZFS receive must create a new dataset.");
                                        historyError.commandOutput = "Choose Create a new dataset and enter a path that does not exist yet. A destination containing snapshots will not be removed automatically.";
                                        throw historyError;
                                    }
                                }
                            }

                            let jobId = replicationJobId();
                            let unitName = "cockpit-zfs-replication-" + jobId + "-" + Date.now() + ".service";
                            let backgroundCommand = [
                                ${JSON.stringify(systemdRunCommand || 'systemd-run')},
                                '--unit=' + unitName,
                                '--description=Cockpit ZFS replication for ${filesystem.name}',
                                '--collect',
                                '--no-block',
                                '--property=Type=oneshot',
                                '--property=KillMode=control-group',
                                ${JSON.stringify(replicationJobHelper || '/usr/share/cockpit/zfs/helpers/run-replication-job')},
                                jobId,
                                unitName,
                                ${JSON.stringify(znapzendCommand || 'znapzend')},
                                '${filesystem.name}',
                                useDestination ? '1' : '0',
                                useDestination ? dstLocation : '',
                                external ? '1' : '0',
                                external ? externalUser + '@' + externalHost : '',
                                useDestination ? dstDataset : '',
                                recoveredIncompleteDestination ? '1' : '0'
                            ];

                            await replicationSpawn(backgroundCommand, { err: "out", superuser: "require" });
                            replicationJobLaunchPendingUntil = Date.now() + 10000;
                            let finalLog = configurationLog + "\\n\\nBackground replication accepted by systemd.\\nUnit: " + unitName + "\\nThe job continues if this page is closed or reloaded.";
                            if (recoveredIncompleteDestination) finalLog += "\\n\\nThe background job will remove the confirmed incomplete destination " + dstLocation + " and recreate it with the initial receive.";
                            $("#replication-task-operation-log-${filesystem.id}").text(finalLog);
                            $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                            FnReplicationWizardShowStep("#modal-storagepool-replication-task-configure-${filesystem.id}", 4);
                            FnReplicationTaskCreate({ name: '${filesystem.name}' }, { name: '${pool.name}', id: '${pool.id}' }, { tag: '${modal.tag}' }, { runNow: true, background: true, unit: unitName, destination: useDestination ? dstLocation : "" });
                            setTimeout(replicationRefreshJobStatus, 500);
                        } catch (error) {
                            let details = replicationErrorText(error);
                            $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                            $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", false);
                            $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("The task was saved, but the background replication could not be started.");
                            $("#replication-task-operation-log-${filesystem.id}").text(configurationLog + "\\n\\nBackground run could not be started:\\n" + details);
                            FnDisplayAlert({ status: "warning", title: "Replication task saved; background run not started", description: details, breakword: true }, { name: "replicationtask-configure" });
                        }
                    }

                    process.then(async data => {
                        if (runNow) {
                            let backgroundConfigurationLog = "[" + new Date().toLocaleString() + "] Configuration completed successfully.\\n\\nCommand:\\n" + command.join(" ") + "\\n\\nOutput:\\n" + (data || "No output.");
                            await replicationStartBackground(backgroundConfigurationLog);
                            return;
                        }
                        let configurationLog = "[" + new Date().toLocaleString() + "] Configuration completed successfully.\\n\\nCommand:\\n" + command.join(" ") + "\\n\\nOutput:\\n" + (data || "No output.");
                        $("#replication-task-operation-log-${filesystem.id}").text(configurationLog + "\\n\\nStarting znapzend service...");

                        let destinationSetup = createDestinationDataset
                            ? replicationSpawn([${JSON.stringify(znapzendSetupCommand || 'znapzendzetup')}, 'enable-dst-autocreation', '${filesystem.name}', 'a'], { err: "out", superuser: "require" })
                            : Promise.resolve("");

                        try {
                            await destinationSetup;
                            await replicationSpawn(['/usr/bin/systemctl', 'reset-failed', 'znapzend.service'], { err: "out", superuser: "require" });

                            let serviceOutput = await replicationSpawn(['/usr/bin/systemctl', 'restart', 'znapzend.service'], { err: "out", superuser: "require" });
                            let finalLog = configurationLog + "\\n\\nDestination auto-creation: " + (createDestinationDataset ? "Enabled" : "Not required") + "\\nService: znapzend.service restarted successfully.\\n" + serviceOutput;
                            $("#replication-task-operation-log-${filesystem.id}").text(finalLog);
                            FnReplicationTaskCreate({ name: '${filesystem.name}' }, { name: '${pool.name}', id: '${pool.id}' }, { tag: '${modal.tag}' }, { runNow: false });
                        } catch (error) {
                            let details = replicationErrorText(error);
                            $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                            $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", false);
                            $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("The task was saved, but the znapzend service could not be started automatically.");
                            $("#replication-task-operation-log-${filesystem.id}").text(configurationLog + "\\n\\nService start failed:\\n" + details);
                            FnDisplayAlert({ status: "warning", title: "Replication task saved; service not started", description: details, breakword: true }, { name: "replicationtask-configure" });
                        }
                    });

                    process.fail((error, output) => {
                        let details = [output, replicationErrorText(error)].filter(Boolean).join("\\n").trim();
                        FnReplicationWizardShowStep("#modal-storagepool-replication-task-configure-${filesystem.id}", 4);
                        $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                        $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", false);
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("znapzend could not save this configuration. Review the detailed output below.");
                        $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Configuration failed.\\n\\nCommand:\\n" + command.join(" ") + "\\n\\nError:\\n" + details);
                        FnDisplayAlert({ status: "danger", title: "Replication task could not be configured", description: "The detailed znapzend error is available in Review & Logs.", breakword: false }, { name: "replicationtask-configure" });
                    });
                    } catch (error) {
                        let details = replicationErrorText(error);
                        FnReplicationWizardShowStep("#modal-storagepool-replication-task-configure-${filesystem.id}", 4);
                        $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                        $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", false);
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("The configuration could not be prepared. Review the technical details below.");
                        $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Configuration preparation failed.\\n\\nError:\\n" + details);
                        FnDisplayAlert({ status: "danger", title: "Replication task could not be prepared", description: details, breakword: true }, { name: "replicationtask-configure" });
                    }
                });

                $("#btn-storagepool-replication-task-delete-${filesystem.id}").on("click", () => {
                    let sourcePool = ${JSON.stringify(pool.name)};
                    let sourceDataset = ${JSON.stringify(filesystem.name)};
                    let confirmed = window.confirm(
                        "Delete the replication task for " + sourceDataset + "?\\n\\n" +
                        "This removes its znapzend replication configuration. Existing datasets and snapshots are not deleted."
                    );
                    if (!confirmed) {
                        $("#replication-task-operation-log-${filesystem.id}").text("Replication task deletion canceled. No changes were made.");
                        return;
                    }

                    let typedPool = window.prompt(
                        "To confirm deletion, type the exact source pool name shown below:\\n\\n" + sourcePool,
                        ""
                    );
                    if (typedPool !== sourcePool) {
                        let cancellationMessage = typedPool === null
                            ? "Replication task deletion canceled. No changes were made."
                            : "Replication task deletion canceled because the pool name did not match " + sourcePool + ".";
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text(cancellationMessage);
                        $("#replication-task-operation-log-${filesystem.id}").text(cancellationMessage);
                        if (typedPool !== null) {
                            FnDisplayAlert({ status: "warning", title: "Replication task was not deleted", description: "Enter the exact source pool name to confirm deletion.", breakword: false }, { name: "replicationtask-delete-confirmation" });
                        }
                        return;
                    }

                    let command = [${JSON.stringify(znapzendSetupCommand || 'znapzendzetup')}, 'delete', '${filesystem.name}'];

                    $("#replication-task-validation-${filesystem.id}").addClass("hidden").empty();
                    $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", true);
                    $("#spinner-storagepool-replication-task-configure-${filesystem.id}").removeClass("hidden");
                    $("#spinner-storagepool-replication-task-configure-${filesystem.id} span").text("Deleting replication task...");

                    let process = cockpit.spawn(command, { err: "out", superuser: "require" });

                    $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Running:\\n" + command.join(" ") + "\\n\\nWaiting for znapzendzetup...");

                    process.then(async data => {
                        try {
                            await replicationSpawn(['/usr/bin/rm', '-f', zfsReplicationJobStatePath(sourceDataset)], { err: "out", superuser: "require" });
                        } catch (error) {
                            // The replication configuration was deleted successfully; stale UI state is non-critical.
                        }
                        FnReplicationTaskDelete({ name: '${filesystem.name}' }, { name: '${pool.name}', id: '${pool.id}' }, { tag: '${modal.tag}' });
                    });

                    process.fail((error, output) => {
                        let details = [output, replicationErrorText(error)].filter(Boolean).join("\\n").trim();
                        FnReplicationWizardShowStep("#modal-storagepool-replication-task-configure-${filesystem.id}", 4);
                        $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                        $("#btn-storagepool-replication-task-configure-run-${filesystem.id}, #btn-storagepool-replication-task-apply-run-now-${filesystem.id}, #btn-storagepool-replication-task-delete-${filesystem.id}").prop("disabled", false);
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("znapzend could not delete this configuration. Review the detailed output below.");
                        $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Delete failed.\\n\\nCommand:\\n" + command.join(" ") + "\\n\\nError:\\n" + details);
                        FnDisplayAlert({ status: "danger", title: "Replication task could not be deleted", description: "The detailed znapzend error is available in Review & Logs.", breakword: false }, { name: "replicationtask-delete" });
                    });
                });

                try {
                    if (!$("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked")) replicationInitializeLocalDestination();
                    replicationToggleExternalFields();
                    replicationDestinationPreview();
                    replicationRefreshJobStatus();
                } catch (error) {
                    $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("Destination fields could not be initialized: " + replicationErrorText(error));
                    $("#replication-task-operation-log-${filesystem.id}").text("Destination initialization failed:\\n" + replicationErrorText(error));
                }
                })();
            </script>
        </div>
    `;

    modal.id.empty().append(modal.content);
    FnReplicationWizardShowStep(modal.id, repTask ? 4 : 1);
    if (loadError) {
        $("#replication-task-operation-log-" + filesystem.id).text("Unable to load the existing znapzend configuration:\n" + loadError);
    }
}

function FnReplicationTaskCreate(filesystem, pool, modal, result) {
    if (result?.background) {
        let description = "The job continues independently from this page.";
        if (result.destination) description += " Destination: " + result.destination + ".";
        FnDisplayAlert({ status: "info", title: "Replication started in background", description, breakword: false }, { name: "replicationtask-configure" });
        return;
    }

    let runCompleted = result?.runNow && result.createdSnapshots?.length;
    let title = runCompleted ? "Replication completed" : "Replication task configured";
    let description = filesystem.name;
    if (runCompleted && result.destination) {
        description = "Created " + result.createdSnapshots.length + " source snapshot(s) and verified " + result.replicatedSnapshots.length + " at " + result.destination + ".";
    } else if (runCompleted) {
        description = "Created: " + result.createdSnapshots.join(", ");
    }
    FnDisplayAlert({ status: "success", title: title, description: description, breakword: false }, { name: "replicationtask-configure" });

    setTimeout(() => {
        $(modal.tag).modal('hide');

        setTimeout(() => {
            FnStoragePoolRefresh({ name: pool.name, id: pool.id }, { storagepool: true, filesystems: true, snapshots: true, status: false });
        }, 200);
    }, 700);
}

function FnReplicationTaskDelete(filesystem, pool, modal) {
    FnDisplayAlert({ status: "success", title: "Replication task deleted", description: filesystem.name, breakword: false }, { name: "replicationtask-delete" });

    setTimeout(() => {
        $(modal.tag).modal('hide');

        setTimeout(() => {
            FnStoragePoolRefresh({ name: pool.name, id: pool.id }, { storagepool: true, filesystems: true, snapshots: true, status: false });
        }, 200);
    }, 700);
}

function AddSrcPlan(element, data = { ret: '7', retUnit: 'Day', int: '1', intUnit: 'Hour', }) {
    let id = Math.floor(Math.random() * 1000);

    $(element).append(`
    <div class="ct-form plan-wrapper" data-type="src" data-id="${id}">
        <div class="replication-ct-plan-heading">
            <strong>Schedule rule</strong>
            <button class="btn btn-link replication-ct-plan-remove" type="button">Remove</button>
        </div>
        <label class="control-label">Create snapshots every</label>
        <div id="validationwrapper-storagepool-replication-task-src-int-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-src-int-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.int}">
            <span id="helpblock-storagepool-replication-task-src-int-${id}" class="help-block"></span>
        </div>
        <label class="control-label replication-ct-unit-label">Interval unit</label>
        <div class="ct-validation-wrapper replication-ct-plan-unit">
            <div class="btn-group bootstrap-select dropdown form-control privileged-modal">
                <button aria-expanded="false" class="btn btn-default dropdown-toggle" data-toggle="dropdown" tabIndex="1" type="button">
                    <span id="btnspan-storagepool-replication-task-src-int-unit-${id}" class="pull-left" data-field-value="${data.intUnit.toLowerCase()}">${data.intUnit}</span>
                    <div class="caret"></div>
                </button>
                <ul id="dropdown-storagepool-replication-task-src-int-unit-${id}" class="dropdown-menu">
                    <li value="second"><a tabindex="-1">Second</a></li><li value="minute"><a tabindex="-1">Minute</a></li><li value="hour"><a tabindex="-1">Hour</a></li><li value="day"><a tabindex="-1">Day</a></li><li value="week"><a tabindex="-1">Week</a></li><li value="month"><a tabindex="-1">Month</a></li><li value="year"><a tabindex="-1">Year</a></li>
                </ul>
            </div>
        </div>
        <label class="control-label">Keep each snapshot for</label>
        <div id="validationwrapper-storagepool-replication-task-src-ret-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-src-ret-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.ret}">
            <span id="helpblock-storagepool-replication-task-src-ret-${id}" class="help-block"></span>
        </div>
        <label class="control-label replication-ct-unit-label">Retention unit</label>
        <div class="ct-validation-wrapper replication-ct-plan-unit">
            <div class="btn-group bootstrap-select dropdown form-control privileged-modal">
                <button aria-expanded="false" class="btn btn-default dropdown-toggle" data-toggle="dropdown" tabIndex="1" type="button">
                    <span id="btnspan-storagepool-replication-task-src-ret-unit-${id}" class="pull-left" data-field-value="${data.retUnit.toLowerCase()}">${data.retUnit}</span>
                    <div class="caret"></div>
                </button>
                <ul id="dropdown-storagepool-replication-task-src-ret-unit-${id}" class="dropdown-menu">
                    <li value="second"><a tabindex="-1">Second</a></li>
                    <li value="minute"><a tabindex="-1">Minute</a></li>
                    <li value="hour"><a tabindex="-1">Hour</a></li>
                    <li value="day"><a tabindex="-1">Day</a></li>
                    <li value="week"><a tabindex="-1">Week</a></li>
                    <li value="month"><a tabindex="-1">Month</a></li>
                    <li value="year"><a tabindex="-1">Year</a></li>
                </ul>
            </div>
        </div>

        <script nonce="1t55lZ7tzuKTreHVNwE66Ox32Mc=">
            $("[data-type='src'][data-id='${id}'] .replication-ct-plan-remove").on("click", function () {
                $(this).closest(".modal").find("select[id^='select-replication-task-src-preset']").val("custom").trigger("change");
                $(this).closest(".plan-wrapper").remove();
            });
            $("#dropdown-storagepool-replication-task-src-ret-unit-${id}").on("click", "li a", function () {
                $("#btnspan-storagepool-replication-task-src-ret-unit-${id}").text($(this).text()).attr("data-field-value", $(this).parent().attr("value"));
                $(this).parent().siblings().removeClass("active");
                $(this).parent().addClass("active");
            });

            $("#dropdown-storagepool-replication-task-src-int-unit-${id}").on("click", "li a", function () {
                $("#btnspan-storagepool-replication-task-src-int-unit-${id}").text($(this).text()).attr("data-field-value", $(this).parent().attr("value"));
                $(this).parent().siblings().removeClass("active");
                $(this).parent().addClass("active");
            });
        </script>
    </div>
`);
}

function AddDstPlan(element, data = { ret: '30', retUnit: 'Day', int: '1', intUnit: 'Hour', }) {
    let id = Math.floor(Math.random() * 1000);

    $(element).append(`
    <div class="ct-form plan-wrapper" data-type="dst" data-id="${id}">
        <div class="replication-ct-plan-heading">
            <strong>Destination retention rule</strong>
            <button class="btn btn-link replication-ct-plan-remove" type="button">Remove</button>
        </div>
        <label class="control-label">Keep each snapshot for</label>
        <div id="validationwrapper-storagepool-replication-task-dst-ret-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-dst-ret-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.ret}">
            <span id="helpblock-storagepool-replication-task-dst-ret-${id}" class="help-block"></span>
        </div>
        <label class="control-label replication-ct-unit-label">Retention unit</label>
        <div class="ct-validation-wrapper replication-ct-plan-unit">
            <div class="btn-group bootstrap-select dropdown form-control privileged-modal">
                <button aria-expanded="false" class="btn btn-default dropdown-toggle" data-toggle="dropdown" tabIndex="1" type="button">
                    <span id="btnspan-storagepool-replication-task-dst-ret-unit-${id}" class="pull-left" data-field-value="${data.retUnit.toLowerCase()}">${data.retUnit}</span>
                    <div class="caret"></div>
                </button>
                <ul id="dropdown-storagepool-replication-task-dst-ret-unit-${id}" class="dropdown-menu">
                <li value="second"><a tabindex="-1">Second</a></li>
                <li value="minute"><a tabindex="-1">Minute</a></li>
                <li value="hour"><a tabindex="-1">Hour</a></li>
                <li value="day"><a tabindex="-1">Day</a></li>
                <li value="week"><a tabindex="-1">Week</a></li>
                <li value="month"><a tabindex="-1">Month</a></li>
                <li value="year"><a tabindex="-1">Year</a></li>
            </ul>
            </div>
        </div>

        <label class="control-label">Keep one snapshot every</label>
        <div id="validationwrapper-storagepool-replication-task-dst-int-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-dst-int-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.int}">
            <span id="helpblock-storagepool-replication-task-dst-int-${id}" class="help-block"></span>
        </div>
        <label class="control-label replication-ct-unit-label">Interval unit</label>
        <div class="ct-validation-wrapper replication-ct-plan-unit">
            <div class="btn-group bootstrap-select dropdown form-control privileged-modal">
                <button aria-expanded="false" class="btn btn-default dropdown-toggle" data-toggle="dropdown" tabIndex="1" type="button">
                    <span id="btnspan-storagepool-replication-task-dst-int-unit-${id}" class="pull-left" data-field-value="${data.intUnit.toLowerCase()}">${data.intUnit}</span>
                    <div class="caret"></div>
                </button>
                <ul id="dropdown-storagepool-replication-task-dst-int-unit-${id}" class="dropdown-menu">
                    <li value="second"><a tabindex="-1">Second</a></li>
                    <li value="minute"><a tabindex="-1">Minute</a></li>
                    <li value="hour"><a tabindex="-1">Hour</a></li>
                    <li value="day"><a tabindex="-1">Day</a></li>
                    <li value="week"><a tabindex="-1">Week</a></li>
                    <li value="month"><a tabindex="-1">Month</a></li>
                    <li value="year"><a tabindex="-1">Year</a></li>
                </ul>
            </div>
        </div>

        <script nonce="1t55lZ7tzuKTreHVNwE66Ox32Mc=">
            $("[data-type='dst'][data-id='${id}'] .replication-ct-plan-remove").on("click", function () {
                $(this).closest(".modal").find("select[id^='select-replication-task-dst-preset']").val("custom").trigger("change");
                $(this).closest(".plan-wrapper").remove();
            });
            $("#dropdown-storagepool-replication-task-dst-ret-unit-${id}").on("click", "li a", function () {
                $("#btnspan-storagepool-replication-task-dst-ret-unit-${id}").text($(this).text()).attr("data-field-value", $(this).parent().attr("value"));
                $(this).parent().siblings().removeClass("active");
                $(this).parent().addClass("active");
            });

            $("#dropdown-storagepool-replication-task-dst-int-unit-${id}").on("click", "li a", function () {
                $("#btnspan-storagepool-replication-task-dst-int-unit-${id}").text($(this).text()).attr("data-field-value", $(this).parent().attr("value"));
                $(this).parent().siblings().removeClass("active");
                $(this).parent().addClass("active");
            });
        </script>
    </div>
`);
}

//#endregion
