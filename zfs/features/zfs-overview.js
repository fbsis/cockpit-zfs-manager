/* Global ZFS overview and per-pool operational observations. */
var ZFSOverview = {
    initialized: false,
    generation: 0,
    pools: {},
    samples: [],
    ioPending: false,
    ioTimer: null,
    detailsTimer: null,

    escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        })[character]);
    },

    number(value) {
        let parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    },

    formatBytes(value) {
        let bytes = Math.max(0, this.number(value));
        let units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
        let unit = 0;

        while (bytes >= 1024 && unit < units.length - 1) {
            bytes /= 1024;
            unit++;
        }

        let decimals = unit === 0 || bytes >= 100 ? 0 : (bytes >= 10 ? 1 : 2);
        return bytes.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 }) + " " + units[unit];
    },

    formatRate(value) {
        return this.formatBytes(value) + "/s";
    },

    formatInteger(value) {
        return Math.round(this.number(value)).toLocaleString();
    },

    init() {
        if (this.initialized) return;
        this.initialized = true;

        $("#zfs-overview").addClass("zfs-overview-ct").html(`
            <header>
                <h3>ZFS Overview</h3>
                <span id="zfs-overview-updated" class="zfs-overview-updated">Loading ZFS statistics...</span>
            </header>
            <div class="zfs-overview-cards">
                <article id="zfs-overview-capacity-card" class="zfs-overview-card">
                    <div class="zfs-overview-card-header">
                        <span class="zfs-overview-card-label">Total capacity</span>
                        <span aria-hidden="true" class="glyphicon glyphicon-hdd zfs-overview-card-icon"></span>
                    </div>
                    <div id="zfs-overview-capacity-value" class="zfs-overview-card-value">—</div>
                    <div id="zfs-overview-capacity-detail" class="zfs-overview-card-detail">Waiting for pools...</div>
                    <div class="zfs-overview-capacity-bar"><span id="zfs-overview-capacity-progress"></span></div>
                </article>
                <article id="zfs-overview-health-card" class="zfs-overview-card">
                    <div class="zfs-overview-card-header">
                        <span class="zfs-overview-card-label">ZFS health</span>
                        <span aria-hidden="true" class="glyphicon glyphicon-heart zfs-overview-card-icon"></span>
                    </div>
                    <div id="zfs-overview-health-value" class="zfs-overview-card-value">—</div>
                    <div id="zfs-overview-health-detail" class="zfs-overview-card-detail">Waiting for pool status...</div>
                </article>
                <article id="zfs-overview-arc-card" class="zfs-overview-card">
                    <div class="zfs-overview-card-header">
                        <span class="zfs-overview-card-label">ARC cache</span>
                        <span aria-hidden="true" class="glyphicon glyphicon-flash zfs-overview-card-icon"></span>
                    </div>
                    <div id="zfs-overview-arc-value" class="zfs-overview-card-value">—</div>
                    <div id="zfs-overview-arc-detail" class="zfs-overview-card-detail">Reading ZFS ARC statistics...</div>
                </article>
                <article class="zfs-overview-chart-card">
                    <div class="zfs-overview-chart-header">
                        <div>
                            <div class="zfs-overview-chart-title">ZFS activity · last 5 minutes</div>
                            <div id="zfs-overview-iops" class="zfs-overview-card-detail">Waiting for the first sample...</div>
                        </div>
                        <div class="zfs-overview-chart-values">
                            <span class="zfs-overview-chart-read">Read <strong id="zfs-overview-read-value">—</strong></span>
                            <span class="zfs-overview-chart-write">Write <strong id="zfs-overview-write-value">—</strong></span>
                        </div>
                    </div>
                    <div class="zfs-overview-chart-wrap">
                        <svg id="zfs-overview-chart" class="zfs-overview-chart" role="img" aria-label="ZFS read and write bandwidth during the last five minutes" viewBox="0 0 600 140" preserveAspectRatio="none"></svg>
                        <div id="zfs-overview-chart-empty" class="zfs-overview-chart-empty">Collecting ZFS I/O samples...</div>
                    </div>
                </article>
            </div>
        `);

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                this.refreshArc();
                this.refreshIostat();
            }
        });
    },

    reset() {
        this.init();
        this.generation++;
        this.pools = {};
        this.samples = [];
        this.renderSummary();
        this.renderChart();
        $("#zfs-overview-updated").text("Loading ZFS statistics...");
    },

    registerPool(pool) {
        this.pools[pool.id] = {
            id: pool.id,
            name: String(pool.name || ""),
            health: String(pool.health || "UNKNOWN").toUpperCase(),
            size: this.number(pool.size),
            allocated: this.number(pool.allocated),
            free: this.number(pool.free),
            fragmentation: this.number(pool.fragmentation),
            autotrim: pool.autotrim === true,
            status: null,
            statusError: false
        };
        this.renderSummary();
    },

    updatePool(pool) {
        let current = this.pools[pool.id];
        if (!current) return this.registerPool(pool);
        current.name = String(pool.name || "");
        current.health = String(pool.health || "UNKNOWN").toUpperCase();
        current.size = this.number(pool.size);
        current.allocated = this.number(pool.allocated);
        current.free = this.number(pool.free);
        current.fragmentation = this.number(pool.fragmentation);
        current.autotrim = pool.autotrim === true;
        this.renderSummary();
    },

    refresh() {
        this.init();
        this.renderSummary();
        this.refreshArc();
        this.refreshPoolObservations();
        this.refreshIostat();
        this.startTimers();
        if (!Object.keys(this.pools).length) {
            $("#zfs-overview-chart-empty").removeClass("hidden").text("No imported ZFS pools to monitor");
        }
    },

    startTimers() {
        if (!this.ioTimer) {
            this.ioTimer = window.setInterval(() => {
                if (!document.hidden) this.refreshIostat();
            }, 5000);
        }

        if (!this.detailsTimer) {
            this.detailsTimer = window.setInterval(() => {
                if (!document.hidden) {
                    this.refreshArc();
                    this.refreshPoolObservations();
                }
            }, 30000);
        }
    },

    renderSummary() {
        let pools = Object.values(this.pools);
        let total = pools.reduce((sum, pool) => sum + pool.size, 0);
        let allocated = pools.reduce((sum, pool) => sum + pool.allocated, 0);
        let percent = total > 0 ? Math.min(100, Math.max(0, allocated / total * 100)) : 0;
        let online = pools.filter(pool => pool.health === "ONLINE").length;
        let statusClass = percent >= 90 ? "danger" : (percent >= 80 ? "warning" : "ok");

        this.setCardStatus("#zfs-overview-capacity-card", statusClass);
        $("#zfs-overview-capacity-value").text(total > 0 ? percent.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "% used" : "No pools");
        $("#zfs-overview-capacity-detail").text(total > 0 ? this.formatBytes(allocated) + " of " + this.formatBytes(total) + " · " + this.formatBytes(Math.max(0, total - allocated)) + " free" : "No imported ZFS storage pools");
        $("#zfs-overview-capacity-progress").css("width", percent + "%");

        let deviceTotal = 0;
        let deviceOnline = 0;
        let errorCount = 0;
        let statusComplete = 0;
        let statusFailed = 0;

        pools.forEach(pool => {
            if (pool.status) {
                statusComplete++;
                deviceTotal += pool.status.devices.total;
                deviceOnline += pool.status.devices.online;
                errorCount += pool.status.readErrors + pool.status.writeErrors + pool.status.checksumErrors;
                if (pool.status.dataErrors) errorCount++;
            } else if (pool.statusError) {
                statusFailed++;
            }
        });

        let healthStatus = online < pools.length || errorCount > 0 ? "danger" : (statusFailed > 0 ? "warning" : "ok");
        this.setCardStatus("#zfs-overview-health-card", healthStatus);
        $("#zfs-overview-health-value").text(pools.length ? online + " / " + pools.length + " pools online" : "No pools");

        if (!pools.length) {
            $("#zfs-overview-health-detail").text("No ZFS health information available");
        } else if (statusComplete + statusFailed < pools.length) {
            $("#zfs-overview-health-detail").text("Checking ZFS devices and error counters...");
        } else {
            let details = deviceTotal ? deviceOnline + " / " + deviceTotal + " devices online" : "No leaf VDEVs reported";
            details += " · " + errorCount + (errorCount === 1 ? " error" : " errors");
            if (statusFailed) details += " · " + statusFailed + " unavailable";
            $("#zfs-overview-health-detail").text(details);
        }
    },

    setCardStatus(selector, status) {
        $(selector).removeClass("zfs-overview-card-status-ok zfs-overview-card-status-warning zfs-overview-card-status-danger");
        if (status) $(selector).addClass("zfs-overview-card-status-" + status);
    },

    parseArcstats(output) {
        let values = {};
        String(output || "").split("\n").forEach(line => {
            let fields = line.trim().split(/\s+/);
            if (fields.length >= 3 && /^\d+$/.test(fields[fields.length - 1])) {
                values[fields[0]] = this.number(fields[fields.length - 1]);
            }
        });
        return values;
    },

    refreshArc() {
        if (!this.initialized) return;

        cockpit.spawn(["/bin/cat", "/proc/spl/kstat/zfs/arcstats"], { err: "out" })
            .done(data => {
                let arc = this.parseArcstats(data);
                let requests = this.number(arc.hits) + this.number(arc.misses);
                let hitRate = requests > 0 ? arc.hits / requests * 100 : 0;
                let l2Requests = this.number(arc.l2_hits) + this.number(arc.l2_misses);
                let l2HitRate = l2Requests > 0 ? arc.l2_hits / l2Requests * 100 : 0;

                this.setCardStatus("#zfs-overview-arc-card", "ok");
                $("#zfs-overview-arc-value").text(arc.size ? this.formatBytes(arc.size) + " ARC" : "ARC available");

                let details = requests > 0 ? hitRate.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "% hit rate" : "No ARC requests recorded";
                if (arc.c) details += " · " + this.formatBytes(arc.c) + " target";
                if (arc.l2_size) details += " · L2ARC " + this.formatBytes(arc.l2_size) + (l2Requests > 0 ? " at " + l2HitRate.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%" : "");
                $("#zfs-overview-arc-detail").text(details).attr("title", arc.c_max ? "ARC maximum: " + this.formatBytes(arc.c_max) : "");
            })
            .fail(() => {
                this.setCardStatus("#zfs-overview-arc-card", "warning");
                $("#zfs-overview-arc-value").text("Unavailable");
                $("#zfs-overview-arc-detail").text("ARC statistics are not exposed by this system").removeAttr("title");
            });
    },

    parseIostat(output) {
        let latest = {};

        String(output || "").split("\n").forEach(line => {
            let fields = line.trim().split(/\s+/);
            let pool = Object.values(this.pools).find(item => item.name === fields[0]);
            if (!pool || fields.length < 7) return;

            latest[pool.id] = {
                readOps: this.number(fields[3]),
                writeOps: this.number(fields[4]),
                read: this.number(fields[5]),
                write: this.number(fields[6])
            };
        });

        return Object.values(latest).reduce((total, sample) => ({
            readOps: total.readOps + sample.readOps,
            writeOps: total.writeOps + sample.writeOps,
            read: total.read + sample.read,
            write: total.write + sample.write
        }), { readOps: 0, writeOps: 0, read: 0, write: 0 });
    },

    refreshIostat() {
        if (this.ioPending || !Object.keys(this.pools).length) return;
        this.ioPending = true;
        let generation = this.generation;

        cockpit.spawn(["/sbin/zpool", "iostat", "-H", "-p", "1", "2"], { err: "out" })
            .done(data => {
                if (generation !== this.generation) return;
                let sample = this.parseIostat(data);
                sample.time = Date.now();
                let previous = this.samples[this.samples.length - 1];
                if (previous && sample.time - previous.time > 15000) this.samples = [];
                this.samples.push(sample);
                if (this.samples.length > 60) this.samples.shift();
                this.renderChart();
                this.updateTimestamp();
            })
            .fail(() => {
                $("#zfs-overview-chart-empty").removeClass("hidden").text("ZFS I/O statistics are unavailable");
            })
            .always(() => {
                this.ioPending = false;
            });
    },

    renderChart() {
        let svg = $("#zfs-overview-chart");
        if (!svg.length) return;

        if (!this.samples.length) {
            svg.empty();
            $("#zfs-overview-read-value, #zfs-overview-write-value").text("—");
            $("#zfs-overview-iops").text("Waiting for the first sample...");
            $("#zfs-overview-chart-empty").removeClass("hidden").text("Collecting ZFS I/O samples...");
            return;
        }

        let width = 600;
        let top = 10;
        let bottom = 130;
        let chartSamples = this.samples.length === 1 ? [this.samples[0], this.samples[0]] : this.samples;
        let maximum = Math.max(1, ...chartSamples.map(sample => Math.max(sample.read, sample.write)));
        let span = Math.max(1, chartSamples.length - 1);
        let point = (sample, index, field) => {
            let x = index / span * width;
            let y = bottom - (sample[field] / maximum * (bottom - top));
            return x.toFixed(1) + "," + y.toFixed(1);
        };
        let readPoints = chartSamples.map((sample, index) => point(sample, index, "read")).join(" ");
        let writePoints = chartSamples.map((sample, index) => point(sample, index, "write")).join(" ");
        let readArea = "0," + bottom + " " + readPoints + " " + width + "," + bottom;

        svg.html(`
            <path class="zfs-overview-chart-grid" d="M0 10 H600 M0 50 H600 M0 90 H600 M0 130 H600"></path>
            <polygon class="zfs-overview-chart-area-read" points="${readArea}"></polygon>
            <polyline class="zfs-overview-chart-line-read" points="${readPoints}"></polyline>
            <polyline class="zfs-overview-chart-line-write" points="${writePoints}"></polyline>
            <text class="zfs-overview-chart-scale" x="4" y="9">${this.escapeHtml(this.formatRate(maximum))}</text>
        `);

        let current = this.samples[this.samples.length - 1];
        $("#zfs-overview-read-value").text(this.formatRate(current.read));
        $("#zfs-overview-write-value").text(this.formatRate(current.write));
        $("#zfs-overview-iops").text(this.formatInteger(current.readOps) + " read IOPS · " + this.formatInteger(current.writeOps) + " write IOPS");
        $("#zfs-overview-chart-empty").addClass("hidden");
    },

    parsePoolStatus(output, poolName) {
        let lines = String(output || "").split("\n");
        let result = {
            scan: { type: "scan", state: "unknown", percent: 0, eta: "", repaired: "", errors: 0, date: null, raw: "" },
            devices: { total: 0, online: 0 },
            readErrors: 0,
            writeErrors: 0,
            checksumErrors: 0,
            dataErrors: false,
            dataErrorText: ""
        };
        let scanIndex = lines.findIndex(line => /^\s*scan:\s*/.test(line));

        if (scanIndex >= 0) {
            let scanLine = lines[scanIndex].replace(/^\s*scan:\s*/, "").trim();
            let scanParts = [scanLine];
            for (let index = scanIndex + 1; index < lines.length && !/^\s*(config|errors):/.test(lines[index]); index++) {
                if (lines[index].trim()) scanParts.push(lines[index].trim());
            }

            result.scan.raw = scanParts.join(" ");
            result.scan.type = /resilver/i.test(scanLine) ? "resilver" : (/scrub/i.test(scanLine) ? "scrub" : "scan");
            result.scan.state = /none requested/i.test(scanLine) ? "never" : (/in progress/i.test(scanLine) ? "running" : (/paused/i.test(scanLine) ? "paused" : (/canceled/i.test(scanLine) ? "canceled" : "completed")));

            let percent = result.scan.raw.match(/([\d.]+)%\s+done/i);
            let eta = result.scan.raw.match(/([\d:]+)\s+to go/i);
            let repaired = result.scan.raw.match(/(?:scrub repaired|resilvered)\s+(\S+)/i);
            let errors = result.scan.raw.match(/with\s+(\d+)\s+errors?/i);
            let completed = scanLine.match(/\bon\s+(.+)$/i);

            if (percent) result.scan.percent = this.number(percent[1]);
            if (eta) result.scan.eta = eta[1];
            if (repaired) result.scan.repaired = repaired[1];
            if (errors) result.scan.errors = this.number(errors[1]);
            if (completed && !/in progress/i.test(scanLine)) {
                let date = new Date(completed[1]);
                if (!Number.isNaN(date.getTime())) result.scan.date = date;
            }
        }

        let configStart = lines.findIndex(line => /^\s*config:\s*$/.test(line));
        let errorsStart = lines.findIndex(line => /^\s*errors:\s*/.test(line));
        let nodes = [];

        if (configStart >= 0) {
            let end = errorsStart > configStart ? errorsStart : lines.length;
            for (let index = configStart + 1; index < end; index++) {
                let match = lines[index].match(/^(\s*)(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED|AVAIL|INUSE)(?:\s+(\d+)\s+(\d+)\s+(\d+))?/i);
                if (!match) continue;
                nodes.push({
                    name: match[2],
                    state: match[3].toUpperCase(),
                    indent: match[1].replace(/\t/g, "        ").length,
                    read: this.number(match[4]),
                    write: this.number(match[5]),
                    checksum: this.number(match[6])
                });
            }
        }

        let root = nodes.find(node => node.name === poolName) || nodes[0];
        nodes.forEach((node, index) => {
            if (node === root) return;
            let next = nodes[index + 1];
            let isLeaf = !next || next.indent <= node.indent;
            if (isLeaf) {
                result.devices.total++;
                if (node.state === "ONLINE" || node.state === "AVAIL" || node.state === "INUSE") result.devices.online++;
                result.readErrors += node.read;
                result.writeErrors += node.write;
                result.checksumErrors += node.checksum;
            }
        });

        if (!result.devices.total && root) {
            result.readErrors = root.read;
            result.writeErrors = root.write;
            result.checksumErrors = root.checksum;
        }

        if (errorsStart >= 0) {
            result.dataErrorText = lines.slice(errorsStart).join(" ").replace(/^\s*errors:\s*/i, "").replace(/\s+/g, " ").trim();
            result.dataErrors = !!result.dataErrorText && !/^no known data errors/i.test(result.dataErrorText);
        }

        return result;
    },

    refreshPoolObservations() {
        let generation = this.generation;
        let pools = Object.values(this.pools);
        if (!pools.length) {
            this.renderSummary();
            return;
        }

        let requests = pools.map(pool => new Promise(resolve => {
            cockpit.spawn(["/sbin/zpool", "status", "-p", pool.name], { err: "out", superuser: "try" })
                .done(data => {
                    if (generation !== this.generation || !this.pools[pool.id]) return resolve();
                    pool.status = this.parsePoolStatus(data, pool.name);
                    pool.statusError = false;
                    resolve();
                })
                .fail(() => {
                    if (generation !== this.generation || !this.pools[pool.id]) return resolve();
                    pool.status = null;
                    pool.statusError = true;
                    resolve();
                });
        }));

        Promise.all(requests).then(() => {
            if (generation === this.generation) {
                this.renderSummary();
                this.updateTimestamp();
            }
        });
    },

    updateTimestamp() {
        $("#zfs-overview-updated").text("Updated " + new Date().toLocaleTimeString());
    }
};
