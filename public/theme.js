// Runs before the page paints so the theme never flashes.
(function () {
  var saved = localStorage.getItem('fm.theme');
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
