/*
 * 主题数据的唯一来源。
 * BASE 定义与配色无关的公共令牌（透明度、圆角、间距、字号、动效）；
 * PALETTES 只描述每套主题的颜色，新增配色只需往 PALETTES 里加一组 color。
 * color 一律 8 位 hex（rrggbbaa），透明度已经写在颜色里，不另写 rgba 数字。
 */
(function () {
  var BASE = {
    alpha: { muted: 0.4, disabled: 0.35 },
    radius: { xs: '4px', sm: '6px', md: '8px', lg: '12px', pill: '999px' },
    spacing: { xxs: '2px', xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px' },
    font: {
      family: 'system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      xs: '11px', sm: '12px', md: '13px', lg: '15px', xl: '18px', xxl: '22px',
      regular: 400, medium: 500, semibold: 600,
      tight: 1.25, base: 1.5
    },
    motion: { fast: '120ms', base: '180ms', slow: '260ms', easing: 'cubic-bezier(.2,.8,.2,1)' }
  };

  var PALETTES = {
    paper: {
      name: '潮白',
      mode: 'light',
      color: {
        bg: 'eeeeeeff',
        surface: 'ffffffff',
        'surface-muted': 'e4e7eaff',
        border: 'd5dbdfff',
        'border-strong': 'b6c0c6ff',
        divider: 'e7e9ebff',
        'grid-line': 'f2f3f4ff',
        text: '0a2c4aff',
        'text-secondary': '2e5677ff',
        'text-muted': '4e6880ff',
        'text-inverse': 'ffffffff',
        brand: '0a4f87ff',
        'brand-contrast': 'ffffffff',
        'brand-soft': '0a4f871f',
        accent: '9c5a2cff',
        'accent-soft': '9c5a2c1f',
        danger: 'b23a32ff',
        'danger-soft': 'b23a3218',
        shadow: '071b2b24',
        scrim: '071b2b8c',
        focus: '0a4f8766'
      }
    },

    reed: {
      name: '苍葭',
      mode: 'light',
      color: {
        bg: 'f3f1e6ff',
        surface: 'fcfbf4ff',
        'surface-muted': 'e9e9dcff',
        border: 'd5d7c8ff',
        'border-strong': 'b3b9aeff',
        divider: 'e5e5d8ff',
        'grid-line': 'edede2ff',
        text: '1e2523ff',
        'text-secondary': '4e5a57ff',
        'text-muted': '7e8884ff',
        'text-inverse': 'ffffffff',
        brand: '2f6b76ff',
        'brand-contrast': 'fbfbf4ff',
        'brand-soft': '2f6b761f',
        accent: '2a6e86ff',
        'accent-soft': '2a6e8624',
        danger: 'a8443aff',
        'danger-soft': 'a8443a1a',
        shadow: '23282126',
        scrim: '2328218c',
        focus: '2f6b7666'
      }
    },

    gravel: {
      name: '岩砾',
      mode: 'dark',
      color: {
        bg: '1b1d1eff',
        surface: '242729ff',
        'surface-muted': '2e3234ff',
        border: '3c4143ff',
        'border-strong': '4f5558ff',
        divider: '2b2e30ff',
        'grid-line': '272a2cff',
        text: 'ece7d9ff',
        'text-secondary': 'b8b5aaff',
        'text-muted': '9a978cff',
        'text-inverse': '1b1d1eff',
        brand: 'cad6daff',
        'brand-contrast': '1b1d1eff',
        'brand-soft': 'cad6da24',
        accent: 'dfbe96ff',
        'accent-soft': 'dfbe9626',
        danger: 'd98a7cff',
        'danger-soft': 'd98a7c1f',
        shadow: '00000073',
        scrim: '0a0b0ca6',
        focus: 'cad6da66'
      }
    },

    moss: {
      name: '苔渊',
      mode: 'dark',
      color: {
        bg: '1d231fff',
        surface: '242b26ff',
        'surface-muted': '29352fff',
        border: '374339ff',
        'border-strong': '3f544bff',
        divider: '242a25ff',
        'grid-line': '202621ff',
        text: 'e7e5d6ff',
        'text-secondary': 'b4b9a9ff',
        'text-muted': '8f9789ff',
        'text-inverse': '1d231fff',
        brand: '74a296ff',
        'brand-contrast': '1d231fff',
        'brand-soft': '74a29624',
        accent: 'b35b44ff',
        'accent-soft': 'b35b4426',
        danger: 'cf7a68ff',
        'danger-soft': 'cf7a6824',
        shadow: '00000066',
        scrim: '10140fa6',
        focus: '74a29666'
      }
    }
  };

  // 旧版本用过 lidong / warm / ink / celadon / mist 五个 id，分别指向现在对应的主题
  var LEGACY = { lidong: 'moss', warm: 'moss', ink: 'gravel', celadon: 'moss', mist: 'reed' };
  var themes = {};

  Object.keys(PALETTES).forEach(function (id) {
    var p = PALETTES[id];
    themes[id] = {
      id: id,
      name: p.name,
      mode: p.mode,
      color: p.color,
      alpha: BASE.alpha,
      radius: BASE.radius,
      spacing: BASE.spacing,
      font: BASE.font,
      motion: BASE.motion
    };
  });

  var COLOR_KEYS = Object.keys(PALETTES.paper.color);

  function resolveTheme(id) {
    if (themes[id]) return id;
    if (LEGACY[id] && themes[LEGACY[id]]) return LEGACY[id];
    return 'paper';
  }

  function check(t) {
    var missing = COLOR_KEYS.filter(function (key) { return !t.color[key]; });
    if (missing.length) {
      console.warn('[theme] ' + t.id + ' 缺少颜色 token：' + missing.join(', '));
    }
  }

  var FONT_VARS = {
    family: '--font-family',
    xs: '--fs-xs', sm: '--fs-sm', md: '--fs-md', lg: '--fs-lg',
    xl: '--fs-xl', xxl: '--fs-xxl',
    regular: '--fw-regular', medium: '--fw-medium', semibold: '--fw-semibold',
    tight: '--lh-tight', base: '--lh-base'
  };

  function applyTheme(id) {
    var resolved = resolveTheme(id);
    var t = themes[resolved];
    check(t);
    var root = document.documentElement;
    Object.keys(t.color).forEach(function (k) { root.style.setProperty('--c-' + k, '#' + t.color[k]); });
    Object.keys(t.alpha).forEach(function (k) { root.style.setProperty('--a-' + k, String(t.alpha[k])); });
    Object.keys(t.radius).forEach(function (k) { root.style.setProperty('--r-' + k, t.radius[k]); });
    Object.keys(t.spacing).forEach(function (k) { root.style.setProperty('--sp-' + k, t.spacing[k]); });
    Object.keys(t.font).forEach(function (k) { root.style.setProperty(FONT_VARS[k], String(t.font[k])); });
    Object.keys(t.motion).forEach(function (k) { root.style.setProperty('--mo-' + k, String(t.motion[k])); });
    root.setAttribute('data-theme', t.id);
    root.setAttribute('data-mode', t.mode);
    root.style.setProperty('color-scheme', t.mode);
    return t.id;
  }

  window.SCHEDULER_THEMES = themes;
  window.resolveTheme = resolveTheme;
  window.applyTheme = applyTheme;
})();