// native-security.js — optional bridge for mobile/desktop secure unlock.
// Browser builds return safe no-op values; Capacitor builds use the native plugin.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.NativeSecurity = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var plugin = null;

  function isNative() {
    return !!(root && root.Capacitor && typeof root.Capacitor.isNativePlatform === 'function'
      && root.Capacitor.isNativePlatform());
  }

  function getPlugin() {
    if (!isNative()) return null;
    if (plugin) return plugin;
    if (root.Capacitor.Plugins && root.Capacitor.Plugins.AppSecurity) {
      plugin = root.Capacitor.Plugins.AppSecurity;
    } else if (typeof root.Capacitor.registerPlugin === 'function') {
      plugin = root.Capacitor.registerPlugin('AppSecurity');
    }
    return plugin;
  }

  function invoke(method, args) {
    var p = getPlugin();
    if (!p || typeof p[method] !== 'function') return Promise.resolve(null);
    return p[method](args || {});
  }

  return {
    isNative: isNative,
    getStatus: function () { return invoke('getStatus'); },
    saveSession: function (token, session) { return invoke('saveSession', { token: token, session: session || {} }); },
    unlock: function () { return invoke('unlock'); },
    clearSession: function () { return invoke('clearSession'); },
  };
});
