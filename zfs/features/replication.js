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

    if (filesystem.replicationtask) {
        try {
            repTask = true;

            let command = ['znapzendzetup', 'list', filesystem.name];

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
    }

    modal.content = `
        <div class="modal-dialog modal-lg replication-ct-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h4 class="modal-title">Configure Replication Task</h4>
                </div>
                <div class="modal-body">
                    <ol class="replication-ct-steps" aria-label="Replication configuration steps">
                        <li class="active" data-step="1"><span>1</span>Source</li>
                        <li data-step="2"><span>2</span>Retention</li>
                        <li data-step="3"><span>3</span>Destination</li>
                        <li data-step="4"><span>4</span>Review &amp; Logs</li>
                    </ol>
                    <section class="replication-ct-step" data-step="1">
                        <h5>Source dataset</h5>
                        <p class="help-block">Choose whether child datasets are included and how much memory can be used while streaming snapshots.</p>
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
                        <label class="control-label">mBuffer Size</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper">
                            <input id="input-storagepool-replication-task-mbuffersize-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${repTask && mBufferSize.length === 2 ? mBufferSize[0] : '1'}">
                            <span id="helpblock-storagepool-replication-task-` + filesystem.id + `" class="help-block"></span>
                        </div>
                        <label class="control-label">mBuffer Unit</label>
                        <div class="ct-validation-wrapper">
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
                        <p class="help-block">Each plan defines how long snapshots are retained and how often they are created. Multiple plans can be combined.</p>
                        <div class="ct-form replication-ct-preset">
                            <label class="control-label" for="select-replication-task-src-preset-${filesystem.id}">Friendly preset</label>
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
                        <h5 class="modal-title">Source Plans <a href="#" id="storagepool-replication-task-add-src-` + filesystem.id + `">&plus;</a></h5>
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
                    <div class="mt-2" id="storagepool-replication-task-dst-plans-` + filesystem.id + `">
                        <h5 class="modal-title">Destination Plans <a href="#" id="storagepool-replication-task-add-dst-` + filesystem.id + `">&plus;</a></h5>
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
                        <label class="control-label external-storagepool-replication-task-item-` + filesystem.id + `">User</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper external-storagepool-replication-task-item-` + filesystem.id + `">
                            <input id="input-storagepool-replication-task-user-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="text" value="${repTask && destination.user ? destination.user : ''}">
                            <span id="helpblock-storagepool-replication-task-` + filesystem.id + `" class="help-block"></span>
                        </div>
                        <label class="control-label external-storagepool-replication-task-item-` + filesystem.id + `">Host</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper external-storagepool-replication-task-item-` + filesystem.id + `">
                            <input id="input-storagepool-replication-task-host-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="text" value="${repTask && destination.host ? destination.host : ''}">
                            <span id="helpblock-storagepool-replication-task-` + filesystem.id + `" class="help-block"></span>
                        </div>
                        <label class="control-label">Destination Dataset</label>
                        <div id="validationwrapper-storagepool-replication-task-` + filesystem.id + `" class="ct-validation-wrapper">
                            <input id="input-storagepool-replication-task-dst-dataset-` + filesystem.id + `" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="text" value="${repTask && destination.dataset ? destination.dataset : ''}">
                            <span id="helpblock-storagepool-replication-task-` + filesystem.id + `" class="help-block"></span>
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
                            <h5>znapzend service logs</h5>
                            <button id="btn-replication-task-logs-${filesystem.id}" class="btn btn-default" type="button">Refresh logs</button>
                        </div>
                        <pre id="replication-task-logs-${filesystem.id}" class="replication-ct-log">Open this step or click Refresh logs to inspect the service.</pre>
                    </section>
                </div>
                <div class="modal-footer">
                    <div></div>
                    <div id="spinner-storagepool-replication-task-configure-` + filesystem.id + `" class="dialog-wait-ct pull-left hidden">
                        <div class="spinner spinner-sm"></div><span></span>
                    </div>
                    <div class="modal-ct-buttons">
                        <button class="btn btn-default cancel" data-dismiss="modal" tabindex="-1">Cancel</button>
                        <button id="btn-replication-task-back-${filesystem.id}" class="btn btn-default hidden" type="button">Back</button>
                        <button id="btn-replication-task-next-${filesystem.id}" class="btn btn-primary" type="button">Next</button>
                        ${filesystem.replicationtask ? `<button id="btn-storagepool-replication-task-delete-${filesystem.id}" class="btn btn-danger apply privileged-modal" tabindex="-1">Delete</button>` : ''}
                        <button id="btn-storagepool-replication-task-configure-run-` + filesystem.id + `" class="btn btn-primary apply privileged-modal hidden" tabindex="-1">Apply configuration</button>
                    </div>
                </div>
            </div>

            <script nonce="1t55lZ7tzuKTreHVNwE66Ox32Mc=">
                (function () {
                ${repTask && destination.external ? '' : `$(".external-storagepool-replication-task-item-${filesystem.id}").css('display', 'none');`}
                ${repTask && useDst ? '' : `$("#storagepool-replication-task-dst-plans-${filesystem.id}").css('display', 'none');`}
                ${repTask && useDst ? '' : `$("#storagepool-replication-task-dst-inputs-${filesystem.id}").css('display', 'none');`}

                function replicationErrorText(error) {
                    if (!error) return "Unknown error returned by znapzend.";
                    let details = [error.message || String(error)];
                    if (error.problem) details.push("Problem: " + error.problem);
                    if (error.exit_status !== undefined) details.push("Exit status: " + error.exit_status);
                    return details.filter(Boolean).join("\n");
                }

                function replicationRefreshLogs() {
                    let output = $("#replication-task-logs-${filesystem.id}");
                    output.text("Loading znapzend service logs...");
                    cockpit.spawn(["journalctl", "-u", "znapzend", "-n", "80", "--no-pager", "--output=short-iso"], { err: "out", superuser: "try" })
                        .then(data => output.text(data.trim() || "No znapzend service entries were found."))
                        .catch(error => output.text("Unable to read the znapzend service log.\n" + replicationErrorText(error)));
                }

                function replicationReview() {
                    let recursive = $("#input-storagepool-replication-task-recursive-${filesystem.id}").prop("checked") ? "Yes" : "No";
                    let destinationEnabled = $("#input-storagepool-replication-task-use-destination-${filesystem.id}").prop("checked");
                    let destinationDataset = $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val();
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    let location = destinationDataset || "Not configured";
                    if (destinationEnabled && external) {
                        location = $("#input-storagepool-replication-task-user-${filesystem.id}").val() + "@" + $("#input-storagepool-replication-task-host-${filesystem.id}").val() + ":" + destinationDataset;
                    }
                    let sourcePlans = [];
                    $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]').each((i, el) => {
                        let id = el.dataset.id;
                        sourcePlans.push($("#input-storagepool-replication-task-src-ret-" + id).val() + " " + $("#btnspan-storagepool-replication-task-src-ret-unit-" + id).text() + " retention / every " + $("#input-storagepool-replication-task-src-int-" + id).val() + " " + $("#btnspan-storagepool-replication-task-src-int-unit-" + id).text());
                    });
                    let destinationPlans = [];
                    $('#dst-storagepool-replication-task-${filesystem.id} > [data-type="dst"]').each((i, el) => {
                        let id = el.dataset.id;
                        destinationPlans.push($("#input-storagepool-replication-task-dst-ret-" + id).val() + " " + $("#btnspan-storagepool-replication-task-dst-ret-unit-" + id).text() + " retention / every " + $("#input-storagepool-replication-task-dst-int-" + id).val() + " " + $("#btnspan-storagepool-replication-task-dst-int-unit-" + id).text());
                    });
                    $("#replication-task-summary-${filesystem.id}").text([
                        "Source: ${filesystem.name}",
                        "Recursive: " + recursive,
                        "mBuffer: " + $("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").val() + $("#btnspan-storagepool-replication-task-mbuffersize-unit-${filesystem.id}").text(),
                        "Source retention plans:\n  - " + sourcePlans.join("\n  - "),
                        "Replication enabled: " + (destinationEnabled ? "Yes" : "No"),
                        "Destination: " + (destinationEnabled ? location : "Snapshots only; no replication destination"),
                        destinationEnabled ? "Destination retention plans:\n  - " + destinationPlans.join("\n  - ") : ""
                    ].filter(Boolean).join("\n"));
                }

                function replicationValidationErrors() {
                    let errors = [];
                    let mBufferSize = Number($("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").val());
                    let sourcePlans = $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]');
                    let destinationEnabled = $("#input-storagepool-replication-task-use-destination-${filesystem.id}").prop("checked");
                    let destinationPlans = $('#dst-storagepool-replication-task-${filesystem.id} > [data-type="dst"]');
                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").prop("checked");
                    if (!Number.isFinite(mBufferSize) || mBufferSize <= 0) errors.push("mBuffer size must be greater than zero.");
                    if (!sourcePlans.length) errors.push("Add at least one source retention plan.");
                    sourcePlans.each((i, el) => {
                        let id = el.dataset.id;
                        if (Number($("#input-storagepool-replication-task-src-ret-" + id).val()) <= 0 || Number($("#input-storagepool-replication-task-src-int-" + id).val()) <= 0) errors.push("Source retention and interval values must be greater than zero.");
                    });
                    if (destinationEnabled && !$("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val().trim()) errors.push("Enter the destination dataset.");
                    if (destinationEnabled && !destinationPlans.length) errors.push("Add at least one destination retention plan.");
                    if (destinationEnabled) destinationPlans.each((i, el) => {
                        let id = el.dataset.id;
                        if (Number($("#input-storagepool-replication-task-dst-ret-" + id).val()) <= 0 || Number($("#input-storagepool-replication-task-dst-int-" + id).val()) <= 0) errors.push("Destination retention and interval values must be greater than zero.");
                    });
                    if (destinationEnabled && external && !$("#input-storagepool-replication-task-user-${filesystem.id}").val().trim()) errors.push("Enter the SSH user for the external destination.");
                    if (destinationEnabled && external && !$("#input-storagepool-replication-task-host-${filesystem.id}").val().trim()) errors.push("Enter the host for the external destination.");
                    return errors;
                }

                $("#modal-storagepool-replication-task-configure-${filesystem.id}").on("replication-wizard-review", function () {
                    replicationReview();
                    replicationRefreshLogs();
                });
                $("#btn-replication-task-logs-${filesystem.id}").on("click", replicationRefreshLogs);

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
                    if (!preset) {
                        $("#replication-task-mbuffer-preset-help-${filesystem.id}").text("Custom buffer size.");
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

                $("#input-storagepool-replication-task-external-${filesystem.id}").on("input", () => {
                    let e = $("#input-storagepool-replication-task-external-${filesystem.id}");
                    let checked = e.get(0).checked;

                    $(".external-storagepool-replication-task-item-` + filesystem.id + `").css('display', checked ? 'grid' : 'none');
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

                $("#storagepool-replication-task-add-src-` + filesystem.id + `").on("click", event => {
                    event.preventDefault();
                    $("#select-replication-task-src-preset-${filesystem.id}").val("custom").trigger("change");
                    AddSrcPlan("#src-storagepool-replication-task-` + filesystem.id + `");
                });

                $("#storagepool-replication-task-add-dst-` + filesystem.id + `").on("click", event => {
                    event.preventDefault();
                    $("#select-replication-task-dst-preset-${filesystem.id}").val("custom").trigger("change");
                    AddDstPlan("#dst-storagepool-replication-task-` + filesystem.id + `");
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

                $("#btn-storagepool-replication-task-configure-run-${filesystem.id}").on("click", () => {
                    let validationErrors = replicationValidationErrors();
                    if (validationErrors.length) {
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").html("<strong>Correct these fields before applying:</strong><ul><li>" + validationErrors.join("</li><li>") + "</li></ul>");
                        return;
                    }
                    let recursive = $("#input-storagepool-replication-task-recursive-` + filesystem.id + `").get(0).checked;
                    let useDestination = $("#input-storagepool-replication-task-use-destination-` + filesystem.id + `").get(0).checked;

                    let mBufferSizeValue = $("#input-storagepool-replication-task-mbuffersize-${filesystem.id}").val();
                    let mBufferSizeUnit = $("#btnspan-storagepool-replication-task-mbuffersize-unit-${filesystem.id}").attr("data-field-value");

                    let srcPlanElements = $('#src-storagepool-replication-task-${filesystem.id} > [data-type="src"]');

                    let dstPlanElements = $('#dst-storagepool-replication-task-${filesystem.id} > [data-type="dst"]');
                    let externalUser = $("#input-storagepool-replication-task-user-${filesystem.id}").val();
                    let externalHost = $("#input-storagepool-replication-task-host-${filesystem.id}").val();
                    let dstDataset = $("#input-storagepool-replication-task-dst-dataset-${filesystem.id}").val();

                    let srcDataset = '${filesystem.name}';

                    let external = $("#input-storagepool-replication-task-external-${filesystem.id}").get(0).checked;

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
                        'znapzendzetup',
                        '${filesystem.replicationtask ? 'edit' : 'create'}',
                        ${filesystem.replicationtask ? "recursive ? '--recursive=on' : '--recursive=off'" : "recursive ? '--recursive' : null"},
                        '--donotask',
                        '--mbuffer=/usr/bin/mbuffer',
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
                    $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Running:\n" + command.join(" ") + "\n\nWaiting for znapzendzetup...");

                    let runConfiguration = () => cockpit.spawn(command, { err: "out", superuser: "require" });
                    let removeOldDestination = ${repTask && useDst} && !useDestination;
                    let process = removeOldDestination
                        ? cockpit.spawn(['znapzendzetup', 'delete', '--dst=a', '${filesystem.name}'], { err: "out", superuser: "require" }).then(runConfiguration)
                        : runConfiguration();

                    process.then(data => {
                        $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Configuration completed successfully.\n\nCommand:\n" + command.join(" ") + "\n\nOutput:\n" + (data || "No output."));
                        FnReplicationTaskCreate({ name: '${filesystem.name}' }, { name: '${pool.name}', id: '${pool.id}' }, { tag: '${modal.tag}' });
                    });

                    process.fail((error, output) => {
                        let details = [output, replicationErrorText(error)].filter(Boolean).join("\n").trim();
                        FnReplicationWizardShowStep("#modal-storagepool-replication-task-configure-${filesystem.id}", 4);
                        $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("znapzend could not save this configuration. Review the detailed output below.");
                        $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Configuration failed.\n\nCommand:\n" + command.join(" ") + "\n\nError:\n" + details);
                        FnDisplayAlert({ status: "danger", title: "Replication task could not be configured", description: "The detailed znapzend error is available in Review & Logs.", breakword: false }, { name: "replicationtask-configure" });
                    });
                });

                $("#btn-storagepool-replication-task-delete-${filesystem.id}").on("click", () => {
                    let command = ['znapzendzetup', 'delete', '${filesystem.name}'];

                    $("#spinner-storagepool-replication-task-configure-${filesystem.id}").removeClass("hidden");
                    $("#spinner-storagepool-replication-task-configure-${filesystem.id} span").text("Deleting replication task...");

                    let process = cockpit.spawn(command, { err: "out", superuser: "require" });

                    $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Running:\n" + command.join(" ") + "\n\nWaiting for znapzendzetup...");

                    process.then(data => {
                        FnReplicationTaskDelete({ name: '${filesystem.name}' }, { name: '${pool.name}', id: '${pool.id}' }, { tag: '${modal.tag}' });
                    });

                    process.fail((error, output) => {
                        let details = [output, replicationErrorText(error)].filter(Boolean).join("\n").trim();
                        FnReplicationWizardShowStep("#modal-storagepool-replication-task-configure-${filesystem.id}", 4);
                        $("#spinner-storagepool-replication-task-configure-${filesystem.id}").addClass("hidden");
                        $("#replication-task-validation-${filesystem.id}").removeClass("hidden").text("znapzend could not delete this configuration. Review the detailed output below.");
                        $("#replication-task-operation-log-${filesystem.id}").text("[" + new Date().toLocaleString() + "] Delete failed.\n\nCommand:\n" + command.join(" ") + "\n\nError:\n" + details);
                        FnDisplayAlert({ status: "danger", title: "Replication task could not be deleted", description: "The detailed znapzend error is available in Review & Logs.", breakword: false }, { name: "replicationtask-delete" });
                    });
                });
                })();
            </script>
        </div>
    `;

    modal.id.empty().append(modal.content);
    FnReplicationWizardShowStep(modal.id, 1);
    if (loadError) {
        $("#replication-task-operation-log-" + filesystem.id).text("Unable to load the existing znapzend configuration:\n" + loadError);
    }
}

function FnReplicationTaskCreate(filesystem, pool, modal) {
    FnDisplayAlert({ status: "success", title: "Replication task configured", description: filesystem.name, breakword: false }, { name: "replicationtask-configure" });

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
        <label class="control-label">Retention Time</label>
        <div id="validationwrapper-storagepool-replication-task-src-ret-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-src-ret-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.ret}">
            <span id="helpblock-storagepool-replication-task-src-ret-${id}" class="help-block"></span>
        </div>
        <label class="control-label">Retention Time Unit</label>
        <div class="ct-validation-wrapper">
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

        <label class="control-label">Interval Time</label>
        <div id="validationwrapper-storagepool-replication-task-src-int-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-src-int-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.int}">
            <span id="helpblock-storagepool-replication-task-src-int-${id}" class="help-block"></span>
        </div>
        <label class="control-label">Interval Time Unit</label>
        <div class="ct-validation-wrapper">
            <div class="btn-group bootstrap-select dropdown form-control privileged-modal">
                <button aria-expanded="false" class="btn btn-default dropdown-toggle" data-toggle="dropdown" tabIndex="1" type="button">
                    <span id="btnspan-storagepool-replication-task-src-int-unit-${id}" class="pull-left" data-field-value="${data.intUnit.toLowerCase()}">${data.intUnit}</span>
                    <div class="caret"></div>
                </button>
                <ul id="dropdown-storagepool-replication-task-src-int-unit-${id}" class="dropdown-menu">
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
        <div></div>
        <div><button class="btn btn-link replication-ct-plan-remove" type="button">Remove plan</button></div>
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
        <label class="control-label">Retention Time</label>
        <div id="validationwrapper-storagepool-replication-task-dst-ret-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-dst-ret-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.ret}">
            <span id="helpblock-storagepool-replication-task-dst-ret-${id}" class="help-block"></span>
        </div>
        <label class="control-label">Retention Time Unit</label>
        <div class="ct-validation-wrapper">
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

        <label class="control-label">Interval Time</label>
        <div id="validationwrapper-storagepool-replication-task-dst-int-${id}" class="ct-validation-wrapper">
            <input id="input-storagepool-replication-task-dst-int-${id}" class="form-control privileged-modal" data-field="name" data-field-type="text-input" tabindex="2" type="number" value="${data.int}">
            <span id="helpblock-storagepool-replication-task-dst-int-${id}" class="help-block"></span>
        </div>
        <label class="control-label">Interval Time Unit</label>
        <div class="ct-validation-wrapper">
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

        <div></div>
        <div><button class="btn btn-link replication-ct-plan-remove" type="button">Remove plan</button></div>
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
