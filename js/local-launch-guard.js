(function () {
  const notice = document.getElementById("localLaunchNotice");
  const appSections = document.querySelectorAll(".app-shell > section:not(#localLaunchNotice)");

  if (window.location.protocol === "file:") {
    document.title = "DEAR-OWL - local launcher required";
    for (const section of appSections) {
      section.hidden = true;
    }
    notice.hidden = false;
    return;
  }

  notice.hidden = true;
  if (new URLSearchParams(window.location.search).get("mode") === "upload") {
    const uploadMode = document.querySelector('input[name="data-mode"][value="upload"]');
    if (uploadMode) {
      uploadMode.checked = true;
    }
  }
}());
