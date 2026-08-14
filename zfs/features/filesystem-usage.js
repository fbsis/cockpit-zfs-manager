/* Filesystem usage calculation and rendering. */
var ZFSFilesystemUsage = {
    calculate(used, available) {
        let total = used + available;
        return Math.min(100, Math.max(0, FnRound({ decimals: 1, value: (used / (total || 1)) * 100 })));
    },

    render(filesystem) {
        let total = filesystem.usedraw + filesystem.availraw;
        return `<td><span class="table-ct-head">Usage:</span><div class="filesystem-ct-usage"><div class="progress progress-sm"><div id="progressbar-filesystem-used-` + filesystem.id + `" aria-valuemax="100" aria-valuemin="0" aria-valuenow="` + filesystem.usedpercent + `" class="progress-bar" role="progressbar"></div><span class="filesystem-ct-usage-value">` + filesystem.usedpercent + `% · ` + FnFormatBytes({ base2: true, decimals: 1, value: filesystem.usedraw }) + ` / ` + FnFormatBytes({ base2: true, decimals: 1, value: total }) + `</span></div></div></td>`;
    },

    update(filesystem) {
        $("#progressbar-filesystem-used-" + filesystem.id).css("width", filesystem.usedpercent + "%");
    }
};
