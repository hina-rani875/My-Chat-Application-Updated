// This is a normal (non-module) script, so the buttons always work.
// If app.js fails to load, the reason is shown in the modal.
(function () {
  var $ = function (s) { return document.querySelector(s); };

  function setMode(mode) {
    var form = $("#authForm");
    form.setAttribute("data-mode", mode);
    $("#tabLogin").classList.toggle("active", mode === "login");
    $("#tabSignup").classList.toggle("active", mode === "signup");
    $("#signupOnly").classList.toggle("hidden", mode !== "signup");
    $("#authSubmit").textContent = mode === "signup" ? "Create account" : "Login";
    $("#authError").textContent = "";
  }

  // Catch the real error here if app.js fails to load so it can be shown in the popup
  var loadError = "";
  window.addEventListener("error", function (e) {
    if (!window.gsReady && e && e.message && !loadError) loadError = e.message;
  });
  var moduleTag = document.querySelector('script[type="module"]');
  if (moduleTag) {
    moduleTag.addEventListener("error", function () {
      if (!loadError) loadError = "app.js was not found or failed to load (check the file name / folder).";
    });
  }

  function warning() {
    if (!window.gsReady) {
      var hint = "";
      if (/config\.js|export named|firebaseConfig|cloudinaryConfig/i.test(loadError)) {
        hint = " → config.js must contain both 'export const firebaseConfig' and 'export const cloudinaryConfig'.";
      } else if (/gstatic|firebase|fetch|Failed to load|network|dynamically imported/i.test(loadError)) {
        hint = " → Check your internet, or try turning off VPN / ad-blocker.";
      }
      return "⚠️ App failed to load" + (loadError ? ": " + loadError : ".") + hint +
        " (Open the page with Live Server and check F12 → Console.)";
    }
    if (window.gsConfigMissing) {
      return "⚠️ First paste your Firebase keys into config.js.";
    }
    return "";
  }

  function openModal(mode) {
    setMode(mode);
    $("#authModal").classList.remove("hidden");
    $("#authError").textContent = warning();
  }

  function closeModal() {
    $("#authModal").classList.add("hidden");
    $("#authError").textContent = "";
  }

  ["#openLogin", "#heroLogin"].forEach(function (s) {
    $(s).addEventListener("click", function () { openModal("login"); });
  });
  ["#openSignup", "#heroSignup", "#bottomSignup"].forEach(function (s) {
    $(s).addEventListener("click", function () { openModal("signup"); });
  });

  $("#closeModal").addEventListener("click", closeModal);
  $("#authModal").addEventListener("click", function (e) {
    if (e.target.id === "authModal") closeModal();
  });
  $("#tabLogin").addEventListener("click", function () { setMode("login"); $("#authError").textContent = warning(); });
  $("#tabSignup").addEventListener("click", function () { setMode("signup"); $("#authError").textContent = warning(); });

  // Prevent page reload; app.js does the real work
  $("#authForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!window.gsReady) $("#authError").textContent = warning();
  });

  // scroll-reveal animation for the landing page
  try {
    var items = document.querySelectorAll("#features h2, #how h2, #features .card, #how .step, .stats > div");
    if ("IntersectionObserver" in window && items.length) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
      }, { threshold: 0.15 });
      items.forEach(function (el, i) { el.classList.add("rv"); el.style.transitionDelay = (i % 6) * 80 + "ms"; io.observe(el); });
    }
  } catch (_) { /* ignore */ }

  $("#avatarInput").addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var prev = $("#avatarPreview");
    prev.textContent = "";
    prev.style.backgroundImage = 'url("' + URL.createObjectURL(f) + '")';
  });
})();
