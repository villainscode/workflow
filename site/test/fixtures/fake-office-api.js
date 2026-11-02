// 오피스 편집 서버(ONLYOFFICE api.js) 대역(6.0 VO 화면 테스트). DocsAPI.DocEditor 모양만 흉내 낸다.
// 열면 자리 요소를 바꾸고 onDocumentReady를 부르며, destroyEditor(닫기)면 대역 서버에 알려 서버가 서명한 저장 콜백(status 2)을 보내게 한다.
(function () {
  var ORIGIN = new URL(document.currentScript.src).origin;
  window.DocsAPI = {
    DocEditor: function (id, config) {
      var slot = document.getElementById(id);
      var frame = document.createElement("div");
      frame.id = id;
      frame.setAttribute("data-fake-office", config.document.key);
      frame.textContent = "가짜 오피스 편집기: " + config.document.title + " (" + config.editorConfig.mode + ")";
      slot.replaceWith(frame);
      setTimeout(function () { if (config.events && config.events.onDocumentReady) config.events.onDocumentReady(); }, 50);
      this.destroyEditor = function () {
        frame.remove();
        fetch(ORIGIN + "/close?key=" + encodeURIComponent(config.document.key) + "&cb=" + encodeURIComponent(config.editorConfig.callbackUrl), { mode: "no-cors" });
      };
    },
  };
})();
