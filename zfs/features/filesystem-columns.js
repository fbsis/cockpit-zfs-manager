/* Optional filesystem table columns. */
var ZFSFilesystemColumns = {
    restore(poolId) {
        $("#panel-storagepool-filesystems-" + poolId + " .filesystem-ct-column-toggle:checked").each(function () {
            let column = $(this).attr("data-column");
            $("#table-storagepool-filesystems-" + poolId + " .filesystem-ct-column-" + column).removeClass("hidden");
        });
    }
};

$(document).on("click", ".filesystem-ct-columns .dropdown-menu", function (event) {
    event.stopPropagation();
});

$(document).on("change", ".filesystem-ct-column-toggle", function () {
    let poolId = $(this).attr("data-pool-id");
    let column = $(this).attr("data-column");
    $("#table-storagepool-filesystems-" + poolId + " .filesystem-ct-column-" + column).toggleClass("hidden", !this.checked);
});
